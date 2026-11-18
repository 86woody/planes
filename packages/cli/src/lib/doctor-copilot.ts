import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Io } from "../main.js";

/** The subset of the Copilot SDK client this check uses. Fakes implement the same shape. */
export type SdkSession = { getEvents(): Promise<unknown[]>; disconnect(): Promise<void> };
export type SdkClient = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  listSessions(): Promise<{ sessionId: string }[]>;
  listModels(): Promise<{ id: string }[]>;
  rpc: { account: { getQuota(params: Record<string, never>): Promise<unknown> } };
  resumeSession(
    sessionId: string,
    config: { suppressResumeEvent: boolean; allowTranscriptRecovery: boolean; enableSessionTelemetry: boolean },
  ): Promise<SdkSession>;
};
export type SdkModule = { CopilotClient: new () => SdkClient };
export type SdkManifest = { version: string; optionalDependencies?: Record<string, string> };

export type CopilotDoctorDeps = {
  /** `--live` given: runs D10. */
  live: boolean;
  nodeVersion: string;
  platform: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Dynamic import of the SDK. Only this function loads it. */
  loadSdk(): Promise<SdkModule>;
  sdkManifest(): Promise<SdkManifest>;
  /** True when the named sibling package is installed next to the SDK. */
  hasPackage(name: string): boolean;
  /** Resolves when koffi loads; rejects otherwise. */
  loadKoffi(): Promise<void>;
  /** Output of `copilot --version`, or null when it fails or is not on PATH. */
  copilotVersion(): Promise<string | null>;
  /** One `copilot -p` run in `cwd` with the given env; kills it at `timeoutMs`. */
  runCopilotPrompt(opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ exitCode: number | null; timedOut: boolean }>;
};

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
type Outcome = { status: Status; detail?: string };
const pass = (detail?: string): Outcome => (detail === undefined ? { status: "PASS" } : { status: "PASS", detail });
const fail = (detail: string): Outcome => ({ status: "FAIL", detail });
const warn = (detail: string): Outcome => ({ status: "WARN", detail });
const skip = (detail: string): Outcome => ({ status: "SKIP", detail });
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const LABELS = [
  "Node",
  "SDK packages",
  "Runtime start",
  "Version match",
  "Sign-in",
  "Session list",
  "Quota and models",
  "Log files",
  "Read-only attach",
  "OTel file",
] as const;

/** Runs D1-D9 (D10 with `live`). Prints one line per check and returns 1 on any FAIL, else 0. */
export async function runCopilotDoctor(io: Io, deps: CopilotDoctorDeps): Promise<number> {
  const statuses: Status[] = [];
  const say = (n: number, o: Outcome): void => {
    statuses.push(o.status);
    const label = LABELS[n - 1] ?? "";
    io.out(`${o.status} D${n} ${label}${o.detail ? `  [${o.detail}]` : ""}`);
  };
  const stateRoot = path.join(deps.env.COPILOT_HOME || path.join(deps.homeDir, ".copilot"), "session-state");

  say(1, checkNode(deps.nodeVersion));

  const packages = await checkPackages(deps);
  say(2, packages.outcome);
  const sdk = packages.sdk;

  let client: SdkClient | undefined;
  let runtimeVersion: string | undefined;
  let signedIn: "yes" | "no" | "unknown" = "unknown";
  try {
    // D3
    let d3: Outcome;
    if (!sdk) {
      d3 = skip("sdk not loaded");
    } else {
      try {
        client = new sdk.CopilotClient();
        await client.start();
        const st = await client.getStatus();
        runtimeVersion = st.version;
        d3 = pass(`runtime ${st.version} protocol ${st.protocolVersion}`);
      } catch (err) {
        d3 = fail(errText(err));
      }
    }
    say(3, d3);
    const started = d3.status === "PASS" && client !== undefined && runtimeVersion !== undefined;

    // D4
    if (!started) {
      say(4, skip("runtime not started"));
    } else {
      say(4, await checkVersionMatch(deps, runtimeVersion ?? ""));
    }

    // D5
    if (!started || !client) {
      say(5, skip("runtime not started"));
    } else {
      try {
        const auth = await client.getAuthStatus();
        if (auth.isAuthenticated) {
          signedIn = "yes";
          say(5, pass("signed in"));
        } else {
          signedIn = "no";
          say(5, skip("not signed in"));
        }
      } catch (err) {
        say(5, fail(errText(err)));
      }
    }

    // D6
    if (!started || !client) {
      say(6, skip("runtime not started"));
    } else {
      say(6, await checkSessionList(client, stateRoot));
    }

    // D7
    if (!started || !client) {
      say(7, skip("runtime not started"));
    } else if (signedIn === "no") {
      say(7, skip("not signed in"));
    } else if (signedIn !== "yes") {
      say(7, skip("D5 did not pass"));
    } else {
      say(7, await checkQuotaAndModels(client));
    }

    // D8 reads files only, so it runs whatever the SDK did.
    say(8, await checkEventsParse(stateRoot));

    // D9
    if (!started || !client) {
      say(9, skip("runtime not started"));
    } else {
      say(9, await checkReadOnlyAttach(client, stateRoot));
    }
  } finally {
    if (client) await client.stop().catch(() => undefined);
  }

  if (deps.live) {
    say(10, await checkOtelFile(deps, stateRoot));
  }

  const failed = statuses.includes("FAIL");
  const run = statuses.filter((s) => s !== "SKIP").length;
  const passed = statuses.filter((s) => s === "PASS").length;
  io.out(`DOCTOR COPILOT ${failed ? "FAIL" : "PASS"} ${passed}/${run}`);
  return failed ? 1 : 0;
}

function checkNode(version: string): Outcome {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 12);
  const detail = `node ${version}`;
  return ok ? pass(detail) : fail(`${detail}, need 22.12 or newer`);
}

async function checkPackages(deps: CopilotDoctorDeps): Promise<{ outcome: Outcome; sdk?: SdkModule }> {
  let sdk: SdkModule;
  try {
    sdk = await deps.loadSdk();
  } catch (err) {
    return { outcome: fail(`sdk does not load: ${errText(err)}`) };
  }
  const manifest = await deps.sdkManifest();
  const runtimeName = `@github/copilot-sdk-${deps.platform}-${deps.arch}`;
  if (!manifest.optionalDependencies || !(runtimeName in manifest.optionalDependencies)) {
    return { outcome: fail(`no runtime package for ${deps.platform}-${deps.arch}`) };
  }
  if (!deps.hasPackage(runtimeName)) {
    return { outcome: fail(`${runtimeName} not installed`) };
  }
  try {
    await deps.loadKoffi();
  } catch (err) {
    return { outcome: fail(`koffi does not load: ${errText(err)}`) };
  }
  return {
    outcome: pass(`sdk ${manifest.version}, ${deps.platform}-${deps.arch} runtime present, koffi loads`),
    sdk,
  };
}

async function checkVersionMatch(deps: CopilotDoctorDeps, runtime: string): Promise<Outcome> {
  const out = await deps.copilotVersion();
  if (out === null) return warn("copilot not on PATH");
  const copilot = /\d+\.\d+\.\d+/.exec(out)?.[0];
  if (!copilot) return warn("copilot printed no version");
  if (copilot === runtime) return pass(`runtime ${runtime}`);
  return warn(`runtime ${runtime}, copilot ${copilot}`);
}

async function checkSessionList(client: SdkClient, stateRoot: string): Promise<Outcome> {
  try {
    const ids = new Set((await client.listSessions()).map((s) => s.sessionId));
    const folders = new Set(await sessionDirs(stateRoot));
    const same = ids.size === folders.size && [...ids].every((id) => folders.has(id));
    if (same) return pass(`${ids.size} sessions`);
    return warn(`runtime ${ids.size}, folders ${folders.size}`);
  } catch (err) {
    return fail(errText(err));
  }
}

async function checkQuotaAndModels(client: SdkClient): Promise<Outcome> {
  try {
    const quota = await client.rpc.account.getQuota({});
    if (!quota) return fail("no quota result");
    const models = await client.listModels();
    if (models.length < 1) return fail("no models listed");
    return pass(`quota ok, models ${models.length}`);
  } catch (err) {
    return fail(errText(err));
  }
}

async function checkEventsParse(stateRoot: string): Promise<Outcome> {
  const newest = (await eventsFiles(stateRoot))[0];
  if (!newest) return skip("no events.jsonl");
  const { bad, records } = parseJsonLines(await readFile(newest.file, "utf8"));
  const detail = `lines ${records.length + bad}, bad lines ${bad}`;
  return bad === 0 ? pass(detail) : fail(detail);
}

async function checkReadOnlyAttach(client: SdkClient, stateRoot: string): Promise<Outcome> {
  let target: EventsFile | undefined;
  for (const candidate of await eventsFiles(stateRoot)) {
    const { records } = parseJsonLines(await readFile(candidate.file, "utf8"));
    if (records.some((r) => isObject(r) && r.type === "session.shutdown")) {
      target = candidate;
      break;
    }
  }
  if (!target) return skip("no ended session");
  try {
    const before = await fingerprint(target.file);
    const session = await client.resumeSession(target.id, {
      suppressResumeEvent: true,
      allowTranscriptRecovery: false,
      enableSessionTelemetry: false,
    });
    try {
      await session.getEvents();
    } finally {
      await session.disconnect();
    }
    const after = await fingerprint(target.file);
    const same = before.size === after.size && before.sha256 === after.sha256;
    const detail = `size ${before.size}, hash ${same ? "unchanged" : "changed"}`;
    return same ? pass(detail) : fail(detail);
  } catch (err) {
    return fail(errText(err));
  }
}

async function checkOtelFile(deps: CopilotDoctorDeps, stateRoot: string): Promise<Outcome> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mc-doctor-copilot-"));
  try {
    const before = new Set(await sessionDirs(stateRoot));
    const otelPath = path.join(tmp, "otel.jsonl");
    const result = await deps.runCopilotPrompt({
      cwd: tmp,
      env: { ...deps.env, COPILOT_OTEL_FILE_EXPORTER_PATH: otelPath },
      timeoutMs: 120_000,
    });
    if (result.timedOut) return fail("copilot did not finish in 120 s");
    let text: string;
    try {
      text = await readFile(otelPath, "utf8");
    } catch {
      return fail("no OTel file written");
    }
    const { records } = parseJsonLines(text);
    const spans = records.filter((r) => isObject(r) && r.type === "span");
    const metrics = records.filter((r) => isObject(r) && r.type === "metric");
    const created = new Set((await sessionDirs(stateRoot)).filter((id) => !before.has(id)));
    const spanMatches = spans.some((s) => {
      const id = conversationId(s);
      return id !== undefined && created.has(id);
    });
    const detail = `span ${spans.length}, metric ${metrics.length}, new session match ${spanMatches ? "yes" : "no"}`;
    return spans.length > 0 && metrics.length > 0 && spanMatches ? pass(detail) : fail(detail);
  } catch (err) {
    return fail(errText(err));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- files -----------------------------------------------------------------

type EventsFile = { id: string; file: string; mtimeMs: number };

async function sessionDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function eventsFiles(root: string): Promise<EventsFile[]> {
  const found: EventsFile[] = [];
  for (const id of await sessionDirs(root)) {
    const file = path.join(root, id, "events.jsonl");
    try {
      const s = await stat(file);
      if (s.isFile()) found.push({ id, file, mtimeMs: s.mtimeMs });
    } catch {
      // no events file in this folder
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Parses JSON lines. Counts bad lines; never keeps or returns the text of a bad line. */
function parseJsonLines(text: string): { records: unknown[]; bad: number } {
  const records: unknown[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

async function fingerprint(file: string): Promise<{ size: number; sha256: string }> {
  const buf = await readFile(file);
  return { size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function conversationId(rec: unknown): string | undefined {
  if (!isObject(rec)) return undefined;
  const attrs = isObject(rec.attributes) ? rec.attributes : undefined;
  const v = attrs?.["gen_ai.conversation.id"] ?? rec["gen_ai.conversation.id"];
  return typeof v === "string" ? v : undefined;
}

// --- real dependencies -----------------------------------------------------

function sdkRoot(): string {
  let dir = path.dirname(createRequire(import.meta.url).resolve("@github/copilot-sdk"));
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath) && (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }).name === "@github/copilot-sdk") {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("copilot-sdk package root not found");
    dir = parent;
  }
}

/** Real dependencies for `mc doctor copilot`. Nothing here loads the SDK until `loadSdk` is called. */
export function realCopilotDoctorDeps(env: NodeJS.ProcessEnv, live: boolean): CopilotDoctorDeps {
  return {
    live,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    env,
    homeDir: os.homedir(),
    loadSdk: async () => {
      const mod = await import("@github/copilot-sdk");
      return { CopilotClient: mod.CopilotClient };
    },
    sdkManifest: async () => JSON.parse(readFileSync(path.join(sdkRoot(), "package.json"), "utf8")) as SdkManifest,
    hasPackage: (name) => existsSync(path.join(path.dirname(sdkRoot()), name.split("/")[1] ?? "")),
    loadKoffi: async () => {
      // The koffi the SDK brings (3.3.6), resolved from the SDK's own folder.
      const entry = createRequire(path.join(sdkRoot(), "package.json")).resolve("koffi");
      await import(pathToFileURL(entry).href);
    },
    copilotVersion: async () => {
      const r = await runProcess("copilot --version", { timeoutMs: 15_000 });
      return r.exitCode === 0 ? r.stdout : null;
    },
    runCopilotPrompt: (opts) =>
      runProcess('copilot -p "Reply with the single word ok"', { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs }),
  };
}

function runProcess(
  command: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stdout });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < 65_536) stdout += String(d);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
