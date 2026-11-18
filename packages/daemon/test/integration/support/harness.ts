// Integration helpers: a real daemon started in-process on a temp MC_HOME, the BUILT mc-hook
// spawned as a child process, and plain HTTP calls. Nothing here touches the real config or
// state directories, binds a fixed port, or depends on the git checkout state.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../../src/main.js";

const HOOK = fileURLToPath(new URL("../../../../hook/dist/mc-hook.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../../contracts/fixtures/ingest/", import.meta.url));

/** Env for every daemon and hook in these tests. */
export function testEnv(home: string): NodeJS.ProcessEnv {
  return { MC_HOME: home, MC_PLATFORM: "fake", MC_TEST: "1", MC_PORT: "0" };
}

/** The daemon reads MC_PLATFORM and MC_TEST from process.env for its test routes (routes/test.ts). */
export function setFakeProcessEnv(): () => void {
  const saved = { MC_PLATFORM: process.env["MC_PLATFORM"], MC_TEST: process.env["MC_TEST"] };
  process.env["MC_PLATFORM"] = "fake";
  process.env["MC_TEST"] = "1";
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "mc-daemon-it-"));
  mkdirSync(path.join(home, "config"), { recursive: true });
  return home;
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

/** A port nothing listens on right now; written to config.json so hooks never reach a real daemon. */
export async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function pinHookToClosedPort(home: string): Promise<void> {
  writeFileSync(path.join(home, "config", "config.json"), JSON.stringify({ port: await closedPort() }));
}

export interface RunningDaemon {
  port: number;
  stop(): Promise<void>;
  url(p: string): string;
  token: string;
  home: string;
}

export async function startTestDaemon(home: string): Promise<RunningDaemon> {
  const env = testEnv(home);
  const started = await startDaemon({ env, foreground: false });
  const token = readFileSync(path.join(home, "state", "token"), "utf8").trim();
  return {
    port: started.port,
    stop: started.stop,
    url: (p: string) => `http://127.0.0.1:${started.port}${p}`,
    token,
    home,
  };
}

export interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built mc-hook with a minimal child env (no terminal variables leak in) from a non-repo cwd. */
export function runHook(args: string[], stdin: string, home: string): Promise<HookResult> {
  const inherited = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME"];
  const env: NodeJS.ProcessEnv = { MC_HOME: home };
  for (const k of inherited) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/** A raw Claude Code hook input (the shape mc-hook reads on stdin) with a unique session id. */
export function rawHookInput(event: string, sessionId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: "C:\\fixture\\transcript.jsonl",
    cwd: "C:\\fixture\\project",
    permission_mode: "default",
    hook_event_name: event,
    ...extra,
  });
}

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

export interface EnvelopeOpts {
  event: string;
  nativeSessionId: string;
  agentPid: number;
  agentStartTime: string | null;
}

/** A valid envelope built from the claude-code SessionStart fixture, with the agent process chosen by the test. */
export function envelopeFor(o: EnvelopeOpts): Record<string, unknown> {
  const base = fixture("cc-session-start.json");
  const origin = base["origin"] as Record<string, unknown>;
  const agent = { pid: o.agentPid, name: "node.exe", startTime: o.agentStartTime };
  return {
    ...base,
    event: o.event,
    nativeSessionId: o.nativeSessionId,
    sentAt: Date.now(),
    origin: { ...origin, hookPid: o.agentPid, agent, ancestry: [agent] },
  };
}

export async function postEnvelope(d: RunningDaemon, env: Record<string, unknown>): Promise<Response> {
  return fetch(d.url("/ingest/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
    body: JSON.stringify(env),
  });
}

export interface SessionView {
  id: string;
  nativeId: string;
  callsign: string;
  state: string;
  attention: { active: boolean; acknowledged: boolean };
}

export async function getState(d: RunningDaemon): Promise<{ sessions: SessionView[] }> {
  const res = await fetch(d.url("/api/state"), { headers: { authorization: `Bearer ${d.token}` } });
  if (!res.ok) throw new Error(`GET /api/state ${res.status}`);
  return (await res.json()) as { sessions: SessionView[] };
}

export async function findSession(d: RunningDaemon, nativeId: string): Promise<SessionView | undefined> {
  return (await getState(d)).sessions.find((s) => s.nativeId === nativeId);
}

export async function fakeCalls(d: RunningDaemon): Promise<{ method: string; args: unknown }[]> {
  const res = await fetch(d.url("/api/test/fake-platform"), { headers: { authorization: `Bearer ${d.token}` } });
  return ((await res.json()) as { calls: { method: string; args: unknown }[] }).calls;
}

/** Polls until predicate is true or the deadline passes; resolves with the last value. */
export async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs: number,
  stepMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    last = await read();
  }
  return last;
}

export function spoolCount(home: string): number {
  try {
    return readdirSync(path.join(home, "state", "spool")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** A dummy long-lived node process used as the "agent" whose exit liveness must notice. */
export function spawnDummyAgent(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
}

export function exited(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

const DAEMON_BIN = fileURLToPath(new URL("../../../../daemon/dist/bin.js", import.meta.url));

export interface DaemonProcess {
  pid: number;
  port: number;
  token: string;
  url(p: string): string;
  child: ReturnType<typeof spawn>;
}

/** A real daemon process (dist/bin.js) on a temp MC_HOME, port 0, MC_PLATFORM=fake. */
export async function spawnDaemonProcess(home: string): Promise<DaemonProcess> {
  const inherited = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME"];
  const env: NodeJS.ProcessEnv = { ...testEnv(home) };
  for (const k of inherited) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  const child = spawn(process.execPath, [DAEMON_BIN], { env, cwd: home, stdio: "ignore", windowsHide: true });
  const daemonFile = path.join(home, "state", "daemon.json");
  const info = await waitFor(
    async () => {
      try {
        return JSON.parse(readFileSync(daemonFile, "utf8")) as { pid: number; port: number };
      } catch {
        return null;
      }
    },
    (v) => v !== null,
    10_000,
    100,
  );
  if (!info) {
    child.kill();
    throw new Error("daemon process did not write daemon.json");
  }
  const token = readFileSync(path.join(home, "state", "token"), "utf8").trim();
  return {
    pid: info.pid,
    port: info.port,
    token,
    url: (p: string) => `http://127.0.0.1:${info.port}${p}`,
    child,
  };
}

/** Resident set size of a process in bytes, read from the OS (PowerShell on Windows, ps elsewhere). */
export function processRssBytes(pid: number): number {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return Number(r.stdout.trim());
  }
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(r.stdout.trim()) * 1024;
}
