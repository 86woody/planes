import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DAEMON_BIN } from "./paths.js";
import type { CliPaths } from "./paths.js";
import { findRunning, isAlive, readDaemonFile, removeDaemonFile } from "./daemon.js";
import type { Running } from "./daemon.js";

export interface ControlIo {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function tailLines(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.length > 0).slice(-n);
}

/** Start the daemon if it is not running. Returns the running daemon, or null after printing why. */
export async function ensureRunning(paths: CliPaths, io: ControlIo): Promise<{ running: Running; started: boolean } | null> {
  const existing = await findRunning(paths);
  if (existing) return { running: existing, started: false };

  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: io.env,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(100);
    const running = await findRunning(paths);
    if (running) {
      io.out(`started pid=${running.pid} port=${running.port}`);
      return { running, started: true };
    }
    if (exited) break;
  }

  if (!exited && child.pid !== undefined) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  io.err("daemon did not start within 5 s; last lines of daemon.log:");
  for (const line of tailLines(paths.logFile, 20)) io.err(line);
  return null;
}

function forceKillWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

export type StopResult = "stopped" | "not-running" | "failed";

/** Stop the daemon named by daemon.json. POSIX: SIGTERM and wait for the file to vanish. Windows: taskkill /F, then delete the file ourselves. */
export async function stopDaemon(paths: CliPaths, io: ControlIo): Promise<StopResult> {
  const file = readDaemonFile(paths);
  if (!file) return "not-running";
  if (!isAlive(file.pid)) {
    removeDaemonFile(paths);
    return "not-running";
  }
  if (process.platform === "win32") {
    await forceKillWindows(file.pid);
    const gone = await waitFor(() => !isAlive(file.pid), 5000);
    if (!gone) {
      io.err(`pid ${file.pid} did not exit after taskkill /F`);
      return "failed";
    }
    removeDaemonFile(paths);
    return "stopped";
  }
  try {
    process.kill(file.pid, "SIGTERM");
  } catch {
    // raced with an exit; the wait below decides
  }
  const removed = await waitFor(() => !existsSync(paths.daemonFile), 5000);
  if (!removed) {
    io.err(`daemon pid=${file.pid} did not remove daemon.json within 5 s`);
    return "failed";
  }
  return "stopped";
}

/** Atomic write of a fresh token: 32 random bytes, base64url, user-only (config.md 2, api.md 2). */
export function rotateTokenFile(paths: CliPaths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(paths.stateDir, `token.${process.pid}.tmp`);
  writeFileSync(tmp, randomBytes(32).toString("base64url"), { mode: 0o600 });
  renameSync(tmp, paths.tokenFile);
  if (existsSync(paths.browserSessionsFile)) rmSync(paths.browserSessionsFile, { force: true });
}
