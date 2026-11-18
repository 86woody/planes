import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { validateEnvelope, type Capabilities, type CopilotAccount } from "@mc/contracts";
import { layout } from "@mc/platform/layout";
import {
  createPlatform,
  FakePlatform,
  processAlive as realProcessAlive,
  type FakeCall,
  type PlatformAdapter,
  type PlatformEnv,
} from "@mc/platform";
import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { createBridgeRegistry } from "./bridge.js";
import { createCopilotAccount } from "./copilot-account.js";
import { createSdkClient } from "./copilot-sdk-client.js";
import { loadConfig } from "./config.js";
import { createFocusService } from "./focus.js";
import type { CapabilitiesCache, Clock, DaemonDeps, Logger, Paths } from "./internal.js";
import { createLiveness } from "./liveness.js";
import { createNotifier } from "./notifier.js";
import { createPersistence } from "./persistence.js";
import { resolvePaths } from "./paths.js";
import { createSessionService } from "./sessions.js";
import { createTelemetry } from "./telemetry.js";
import { createTraceStore } from "./traces.js";
import type { SessionService } from "./internal.js";
import { wsHub } from "./ws.js";

/** Single-instance check found a live daemon on this MC_HOME (AC-14, ARCHITECTURE.md 2). */
export class AlreadyRunning extends Error {
  constructor(readonly pid: number, readonly port: number) {
    super(`already running pid=${pid} port=${port}`);
    this.name = "AlreadyRunning";
  }
}

/** config.json failed validation at start (config.md 3). */
export class ConfigInvalid extends Error {
  constructor(readonly errors: string[]) {
    super(`config invalid: ${errors.join("; ")}`);
    this.name = "ConfigInvalid";
  }
}

/** 127.0.0.1:<port> is held by another process (D-13). */
export class PortInUse extends Error {
  constructor(readonly port: number) {
    super(`port ${port} in use`);
    this.name = "PortInUse";
  }
}

const CAPABILITIES_TTL_MS = 60_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const HOOK_ERRORS_KEEP_LINES = 500;
const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE"] as const;

/**
 * FakePlatform for MC_PLATFORM=fake. Its scripted processAlive says "alive" for every pid, which
 * would make liveness (AC-13, PS-05) untestable. Liveness here is the real process check, and the
 * fake still records the call.
 */
class DaemonFakePlatform extends FakePlatform {
  override async processAlive(pid: number, startTime: string | null): Promise<boolean> {
    const scripted = await super.processAlive(pid, startTime);
    return scripted && (await realProcessAlive(pid, startTime));
  }
}

function fileLogger(logFile: string, clock: Clock): Logger {
  mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    if (existsSync(logFile) && statSync(logFile).size > LOG_ROTATE_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // Rotation is best effort; logging must not stop the daemon.
  }
  const write = (level: string, o: object, msg?: string): void => {
    try {
      appendFileSync(logFile, `${JSON.stringify({ time: clock.now(), level, ...o, msg })}\n`);
    } catch {
      // A failing log write never fails the daemon.
    }
  };
  return {
    info: (o, msg) => write("info", o, msg),
    warn: (o, msg) => write("warn", o, msg),
    error: (o, msg) => write("error", o, msg),
  };
}

/** A daemon.json whose pid is alive and whose /healthz answers with that pid within 500 ms. */
async function findRunning(paths: Paths): Promise<{ pid: number; port: number } | null> {
  if (!existsSync(paths.daemonFile)) return null;
  let parsed: { pid?: unknown; port?: unknown };
  try {
    parsed = JSON.parse(readFileSync(paths.daemonFile, "utf8")) as { pid?: unknown; port?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
  try {
    process.kill(parsed.pid, 0);
  } catch {
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${parsed.port}/healthz`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: unknown };
    return body.pid === parsed.pid ? { pid: parsed.pid, port: parsed.port } : null;
  } catch {
    return null;
  }
}

function trimHookErrors(file: string): void {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  if (lines.length > HOOK_ERRORS_KEEP_LINES) {
    writeFileSync(file, `${lines.slice(-HOOK_ERRORS_KEEP_LINES).join("\n")}\n`);
  }
}

/** The newest record that has any display variable fills the ones process.env lacks (T027 step 1.4). */
function displayEnvFrom(base: NodeJS.ProcessEnv, sessions: SessionService): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  const withDisplay = sessions
    .records()
    .filter((r) => r.origin !== null && DISPLAY_KEYS.some((k) => r.origin?.env?.[k] !== undefined))
    .sort((a, b) => Date.parse(b.session.updatedAt) - Date.parse(a.session.updatedAt));
  const newest = withDisplay[0]?.origin?.env;
  if (!newest) return out;
  for (const k of DISPLAY_KEYS) {
    if (out[k] === undefined && newest[k] !== undefined) out[k] = newest[k];
  }
  return out;
}

function cachedCapabilities(platform: PlatformAdapter, clock: Clock): CapabilitiesCache {
  let cached: { at: number; value: Capabilities } | null = null;
  return {
    async get() {
      if (cached && clock.now() - cached.at < CAPABILITIES_TTL_MS) return cached.value;
      const value = await platform.capabilities();
      cached = { at: clock.now(), value };
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}

/**
 * Starts the daemon in this process (internal.md 2, T027). Order: paths, single instance,
 * config, auth, persistence, sessions, platform, bridges, focus, notifier, liveness, app,
 * listen, daemon.json, spool ingest, log truncation, notifier and liveness start.
 */
export async function startDaemon(opts: {
  env: NodeJS.ProcessEnv;
  foreground: boolean;
}): Promise<{ port: number; stop(): Promise<void> }> {
  const { env, foreground } = opts;
  const lay = layout();
  const paths = resolvePaths(env, process.platform, os.homedir());
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  const clock: Clock = { now: () => Date.now() };
  const log = fileLogger(paths.logFile, clock);

  const running = await findRunning(paths);
  if (running) throw new AlreadyRunning(running.pid, running.port);

  const loaded = await loadConfig(paths, env);
  if (!loaded.ok) throw new ConfigInvalid(loaded.errors);
  const config = loaded.store;

  const auth = await createAuth(paths, clock);
  const persistence = createPersistence(paths, clock, log);
  const initial = await persistence.load();
  const sessions = createSessionService({ clock, config, persistence, initial });
  // Every path derives from MC_HOME when set (AGENTS.md test hygiene): test daemons never read the real ~/.copilot.
  const copilotHome =
    env["COPILOT_HOME"] ?? (env["MC_HOME"] ? path.join(env["MC_HOME"], "copilot") : path.join(os.homedir(), ".copilot"));
  const traces = createTraceStore({ clock, log, paths, sessions });
  // D-61: Claude Code transcripts, the same rule (a test daemon reads <MC_HOME>/claude).
  const claudeHome =
    env["CLAUDE_CONFIG_DIR"] ?? (env["MC_HOME"] ? path.join(env["MC_HOME"], "claude") : path.join(os.homedir(), ".claude"));
  const telemetry = createTelemetry({ clock, log, sessions, paths, traces }, { copilotHome, claudeHome });

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const platformEnv: PlatformEnv = {
    stateDir: paths.stateDir,
    config: config.get(),
    repoRoot: lay.root,
    displayEnv: () => displayEnvFrom(baseEnv, sessions),
  };
  const platform: PlatformAdapter =
    baseEnv["MC_PLATFORM"] === "fake"
      ? new DaemonFakePlatform(undefined, (c: FakeCall) =>
          appendFileSync(paths.fakePlatformFile, `${JSON.stringify(c)}\n`),
        )
      : await createPlatform(platformEnv);

  const cleanups: Array<() => Promise<void> | void> = [() => platform.dispose()];
  const undo = async (): Promise<void> => {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // Startup failure path: keep unwinding.
      }
    }
  };

  try {
    const bridges = createBridgeRegistry({ clock, log, platform });
    cleanups.push(() => bridges.close());
    const focus = createFocusService({ clock, log, config, sessions, platform, bridges });
    const broadcast: DaemonDeps["broadcast"] = (msg) => {
      wsHub.emit("msg", msg);
    };
    // D-56 (T114): off under MC_TEST=1 or MC_COPILOT_SDK=0; then no SDK client is ever made.
    const copilotOff = env["MC_TEST"] === "1" || env["MC_COPILOT_SDK"] === "0";
    const copilot: DaemonDeps["copilot"] & { start(): void; stop(): Promise<void> } = copilotOff
      ? { current: (): CopilotAccount | null => null, start: (): void => undefined, stop: async (): Promise<void> => undefined }
      : createCopilotAccount(
          { clock, log, sessions },
          { client: createSdkClient(), onChange: () => broadcast({ type: "daemon.update" }) },
        );
    const notifier = createNotifier({ clock, log, config, sessions, platform, focus, broadcast });
    const liveness = createLiveness({ clock, config, sessions, platform });
    const capabilities = cachedCapabilities(platform, clock);
    const startedAt = new Date(clock.now()).toISOString();

    const deps: DaemonDeps = {
      clock,
      log,
      paths,
      config,
      auth,
      sessions,
      persistence,
      bridges,
      focus,
      notifier,
      liveness,
      platform,
      capabilities,
      version: lay.version,
      startedAt,
      broadcast,
      copilot,
      traces,
    };

    const uiDir = existsSync(lay.uiDir) ? lay.uiDir : null;
    const app = await buildApp(deps, { uiDir, testMode: env["MC_TEST"] === "1" });
    cleanups.push(() => app.close());

    const port = env["MC_PORT"] !== undefined && env["MC_PORT"] !== "" ? Number(env["MC_PORT"]) : config.get().port;
    try {
      await app.listen({ host: "127.0.0.1", port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortInUse(port);
      throw err;
    }
    const bound = (app.server.address() as AddressInfo).port;

    writeFileSync(
      paths.daemonFile,
      JSON.stringify({ pid: process.pid, port: bound, startedAt, version: lay.version }),
    );
    cleanups.push(() => {
      // Remove daemon.json only if it still names this process.
      try {
        const d = JSON.parse(readFileSync(paths.daemonFile, "utf8")) as { pid?: unknown };
        if (d.pid === process.pid) rmSync(paths.daemonFile, { force: true });
      } catch {
        // Already gone.
      }
    });

    for (const { file, envelope } of await persistence.readSpool()) {
      const v = validateEnvelope(envelope);
      if (v.ok) sessions.ingest(v.value, clock.now());
      await persistence.deleteSpool(file);
    }

    trimHookErrors(paths.hookErrorsFile);

    notifier.start();
    liveness.start();
    const adapterCfg = config.get().adapters as Record<string, { enabled?: boolean } | undefined> | undefined;
    if (adapterCfg?.["copilot-cli"]?.enabled !== false) telemetry.start();
    copilot.start();
    cleanups.push(() => copilot.stop());
    cleanups.push(() => {
      liveness.stop();
      notifier.stop();
    });
    await liveness.checkNow();
    for (const r of sessions.records()) {
      if (r.session.state === "ended" || r.session.state === "lost") continue;
      await focus.resolve(r.session.id).catch(() => undefined);
    }

    log.info({ port: bound, pid: process.pid, version: lay.version }, "daemon started");

    let stopping: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (foreground) {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
        liveness.stop();
        notifier.stop();
        telemetry.stop();
        await copilot.stop();
        await app.close();
        bridges.close();
        config.close();
        await traces.flush();
        await persistence.flush();
        await auth.flush();
        await platform.dispose();
        try {
          const d = JSON.parse(readFileSync(paths.daemonFile, "utf8")) as { pid?: unknown };
          if (d.pid === process.pid) rmSync(paths.daemonFile, { force: true });
        } catch {
          // Already gone.
        }
        log.info({ port: bound }, "daemon stopped");
      })();
      return stopping;
    };
    const onSignal = (): void => {
      void stop().then(() => process.exit(0));
    };
    if (foreground) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }

    return { port: bound, stop };
  } catch (err) {
    await undo();
    throw err;
  }
}
