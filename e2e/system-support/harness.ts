// T054 system e2e helpers: real mc / mc-hook processes against a temp sandbox.
// Every process runs with MC_HOME, CLAUDE_CONFIG_DIR and HOME pointing into a temp
// directory, MC_PLATFORM=fake and MC_TEST=1; the daemon listens on a port found by
// binding port 0 (never MC_PORT).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MC_JS = path.join(ROOT, "packages/cli/dist/mc.js");
const RAW_DIR = path.join(ROOT, "packages/contracts/fixtures/ingest/raw");

export interface Sandbox {
  root: string;
  mcHome: string;
  stateDir: string;
  claudeDir: string;
  settingsPath: string;
  home: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("no port bound"));
      }
    });
  });
}

export async function createSandbox(): Promise<Sandbox> {
  const root = mkdtempSync(path.join(tmpdir(), "mc-t054-"));
  const mcHome = path.join(root, "mc");
  const home = path.join(root, "home");
  const claudeDir = path.join(root, "claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  const port = await freePort();
  mkdirSync(path.join(mcHome, "config"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(mcHome, "config", "config.json"), JSON.stringify({ port }, null, 2) + "\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MC_HOME: mcHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    MC_PLATFORM: "fake",
    MC_TEST: "1",
  };
  delete env.MC_PORT;
  return {
    root,
    mcHome,
    stateDir: path.join(mcHome, "state"),
    claudeDir,
    settingsPath,
    home,
    port,
    env,
  };
}

function collect(child: ReturnType<typeof spawn>, input?: string, timeoutMs = 20000): Promise<Run> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export function runMc(sb: Sandbox, args: string[], timeoutMs = 20000): Promise<Run> {
  const child = spawn(process.execPath, [MC_JS, ...args], {
    cwd: ROOT,
    env: sb.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return collect(child, undefined, timeoutMs);
}

export interface HookCommand {
  command: string;
  args: string[];
}

interface SettingsHook {
  type: string;
  command: string;
  args?: string[];
}

// The installed exec-form hook object for an event (claude-hooks.md 1, 2).
export function installedHook(sb: Sandbox, event: string): HookCommand {
  const settings = JSON.parse(readFileSync(sb.settingsPath, "utf8")) as {
    hooks?: Record<string, { hooks: SettingsHook[] }[]>;
  };
  for (const group of settings.hooks?.[event] ?? []) {
    for (const hook of group.hooks) {
      const args = hook.args ?? [];
      if (args.length === 2 && args[0]?.endsWith("mc-hook.js") && args[1] === "claude-code") {
        return { command: hook.command, args };
      }
    }
  }
  throw new Error(`no installed mc-hook command for ${event}`);
}

// Runs an installed hook the way Claude Code does: exec form, raw hook JSON on stdin.
export function runHook(sb: Sandbox, hook: HookCommand, raw: object): Promise<Run> {
  const child = spawn(hook.command, hook.args, {
    cwd: ROOT,
    env: sb.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return collect(child, JSON.stringify(raw), 10000);
}

export function rawFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(RAW_DIR, name), "utf8")) as Record<string, unknown>;
}

// No raw cc-session-end fixture exists under fixtures/ingest/raw; the SessionEnd input is
// built from the SessionStart fixture's shared fields (same session_id, cwd, permission_mode).
export function sessionEndRaw(): Record<string, unknown> {
  const start = rawFixture("cc-session-start.json");
  return {
    session_id: start.session_id,
    transcript_path: start.transcript_path,
    cwd: start.cwd,
    permission_mode: start.permission_mode,
    hook_event_name: "SessionEnd",
    reason: "other",
  };
}

export function readToken(sb: Sandbox): string {
  return readFileSync(path.join(sb.stateDir, "token"), "utf8").trim();
}

export function readDaemon(sb: Sandbox): { pid: number; port: number } | null {
  try {
    return JSON.parse(readFileSync(path.join(sb.stateDir, "daemon.json"), "utf8")) as {
      pid: number;
      port: number;
    };
  } catch {
    return null;
  }
}

export function baseUrl(sb: Sandbox): string {
  return `http://127.0.0.1:${sb.port}`;
}

// Bearer-authenticated call to the daemon (no Origin header, as the CLI sends).
export async function api(sb: Sandbox, method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl(sb)}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${readToken(sb)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export interface FakeCall {
  at: number;
  method: string;
  args: unknown;
}

export async function fakeCalls(sb: Sandbox): Promise<FakeCall[]> {
  const res = await api(sb, "GET", "/api/test/fake-platform");
  if (res.status !== 200) throw new Error(`fake-platform returned ${res.status}`);
  return (res.json as { calls: FakeCall[] }).calls;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
