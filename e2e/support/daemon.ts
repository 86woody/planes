import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { Mc } from "./events";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

let built = false;
/** Global setup in effect: `npm run build` runs once per Playwright process. */
function ensureBuilt(): void {
  if (built) return;
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "pipe", shell: true });
  built = true;
}

/** One real daemon process on a temp MC_HOME with the fake platform (D-19). */
export class Daemon {
  readonly home: string;
  port = 0;
  token = "";
  private proc: ChildProcess | null = null;

  constructor() {
    this.home = mkdtempSync(path.join(tmpdir(), "mc-e2e-"));
  }

  get stateDir(): string {
    return path.join(this.home, "state");
  }

  /** Starts the daemon; port 0 is ephemeral, a fixed port is used to restart in place. */
  async start(port = 0): Promise<void> {
    ensureBuilt();
    const daemonFile = path.join(this.stateDir, "daemon.json");
    if (existsSync(daemonFile)) unlinkSync(daemonFile);
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "packages/daemon/dist/bin.js")], {
      env: { ...process.env, MC_HOME: this.home, MC_PORT: String(port), MC_PLATFORM: "fake", MC_TEST: "1" },
      stdio: "ignore",
      windowsHide: true,
    });
    this.proc = child;
    const deadline = Date.now() + 15_000;
    let bound = false;
    while (Date.now() < deadline && !bound) {
      if (child.exitCode !== null) throw new Error(`daemon exited early with ${child.exitCode}`);
      if (existsSync(daemonFile)) {
        try {
          const info = JSON.parse(readFileSync(daemonFile, "utf8")) as { pid: number; port: number };
          if (info.pid === child.pid && info.port > 0) {
            this.port = info.port;
            bound = true;
          }
        } catch {
          // daemon.json is still being written; retry
        }
      }
      if (!bound) await sleep(50);
    }
    if (!bound) throw new Error("daemon did not write daemon.json within 15 s");
    this.token = readFileSync(path.join(this.stateDir, "token"), "utf8").trim();
  }

  /** Kills the daemon (TerminateProcess on Windows: no graceful shutdown). */
  async stop(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, sleep(5_000)]);
  }

  /** Stops the daemon and starts it again on the same port with the same MC_HOME (CARD-04). */
  async restart(): Promise<void> {
    const port = this.port;
    await this.stop();
    await this.start(port);
  }
}

export const test = base.extend<{ mc: Mc }>({
  // Playwright requires an object pattern as the first fixture argument, even when it is empty.
  // eslint-disable-next-line no-empty-pattern
  mc: async ({}, use) => {
    const daemon = new Daemon();
    await daemon.start(0);
    const mc = new Mc(daemon);
    try {
      await use(mc);
    } finally {
      await daemon.stop();
      mc.dispose();
      try {
        rmSync(daemon.home, { recursive: true, force: true });
      } catch {
        // temp dir cleanup is best effort on Windows
      }
    }
  },
});
