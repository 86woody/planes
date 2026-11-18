import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Daemon } from "./daemon";

/** Project and branch every fixture session reports, independent of the checkout. */
export const PROJECT_NAME = "mc-e2e-project";
export const BRANCH = "feature/e2e";

/**
 * A throwaway git repo for one test: a fixed directory name under a fresh OS temp dir, on
 * branch BRANCH, with one commit. The daemon reads project and branch from it (git.ts).
 */
function createProjectRepo(): { root: string; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "mc-e2e-"));
  const dir = path.join(root, PROJECT_NAME);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=mc-e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", ...args], {
      stdio: "pipe",
    });
  git("init", "-q");
  git("symbolic-ref", "HEAD", `refs/heads/${BRANCH}`);
  writeFileSync(path.join(dir, "README.md"), "mission-control e2e fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return { root, dir };
}

export interface FakeCallLike {
  at: number;
  method: string;
  args: unknown;
}

export interface SendOpts {
  /** nativeSessionId; the card id is `claude-code:<session>`. */
  session: string;
  /** Agent pid. Default: this runner's pid (live, with its real start time). null = no agent. */
  agentPid?: number | null;
  /** Overrides the envelope sentAt (ms). Default: the Mc anchor plus a rising counter. */
  sentAt?: number;
  /** Origin env; default is a Windows Terminal origin. */
  env?: Record<string, string>;
}

let runnerStart: string | null | undefined;

/** The runner's own process start time in the daemon's format (FILETIME decimal on Windows). */
function runnerStartTime(): string | null {
  if (runnerStart !== undefined) return runnerStart;
  if (process.platform !== "win32") {
    runnerStart = null;
    return runnerStart;
  }
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`],
    { encoding: "utf8" },
  );
  runnerStart = out.trim();
  return runnerStart;
}

/** Talks to one running daemon: ingests envelopes and reads the test routes. */
export class Mc {
  /** Base for envelope sentAt values; tests may move it (DS-08 freezes it). */
  anchor: number;
  private n = 0;

  /** Temp git repo used as the cwd of every session in this test. */
  readonly projectRoot: string;
  readonly projectDir: string;

  constructor(readonly daemon: Daemon) {
    this.anchor = Date.now() - 60_000;
    const repo = createProjectRepo();
    this.projectRoot = repo.root;
    this.projectDir = repo.dir;
  }

  /** Removes the temp project repo (the fixture calls this in teardown). */
  dispose(): void {
    try {
      rmSync(this.projectRoot, { recursive: true, force: true });
    } catch {
      // best effort on Windows; the OS temp dir is cleared eventually
    }
  }

  get port(): number {
    return this.daemon.port;
  }

  get token(): string {
    return this.daemon.token;
  }

  /** The SessionId the daemon assigns to a Claude Code session. */
  sid(session: string): string {
    return `claude-code:${session}`;
  }

  private url(p: string): string {
    return `http://127.0.0.1:${this.port}${p}`;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  /** POSTs one Claude Code hook event as an IngestEnvelope (ingest.md, api.md 3). */
  async send(event: string, payload: Record<string, unknown>, opts: SendOpts): Promise<void> {
    const agentPid = opts.agentPid === undefined ? process.pid : opts.agentPid;
    const startTime = agentPid === null ? null : runnerStartTime();
    const envelope = {
      v: 1,
      adapter: "claude-code",
      event,
      nativeSessionId: opts.session,
      sentAt: opts.sentAt ?? this.anchor + ++this.n,
      seq: 0,
      payload: { cwd: this.projectDir, ...payload },
      origin: {
        os: "windows",
        hookPid: process.pid,
        agent:
          agentPid === null
            ? null
            : { pid: agentPid, name: "node.exe", ...(startTime ? { startTime } : {}) },
        ancestry: [],
        tty: null,
        env: opts.env ?? { WT_SESSION: "4d1f2c3a-0000-4000-8000-000000000001" },
        console: { consoleHwnd: null, ownerHwnd: null },
      },
    };
    const res = await fetch(this.url("/ingest/v1/events"), {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify(envelope),
    });
    if (res.status !== 202) throw new Error(`ingest ${res.status}: ${await res.text()}`);
  }

  /** Fake platform calls recorded by the daemon (api.md 3, MC_TEST=1 only). */
  async fakeCalls(): Promise<FakeCallLike[]> {
    const res = await fetch(this.url("/api/test/fake-platform"), { headers: this.auth() });
    if (!res.ok) throw new Error(`fake-platform ${res.status}`);
    const body = (await res.json()) as { calls: FakeCallLike[] };
    return body.calls;
  }

  async countCalls(method: string): Promise<number> {
    return (await this.fakeCalls()).filter((c) => c.method === method).length;
  }

  /** Makes the fake report that session's window as foreground (null clears it). */
  async setForeground(sessionId: string | null): Promise<void> {
    const res = await fetch(this.url("/api/test/fake-platform/foreground"), {
      method: "POST",
      headers: { "content-type": "application/json", ...this.auth() },
      body: JSON.stringify({ sessionId }),
    });
    if (res.status !== 204) throw new Error(`foreground ${res.status}`);
  }

  /** A fresh pairing code for the page (api.md 3, bearer realm). */
  async pairCode(): Promise<string> {
    const res = await fetch(this.url("/api/pair-code"), { method: "POST", headers: this.auth() });
    if (!res.ok) throw new Error(`pair-code ${res.status}`);
    const body = (await res.json()) as { code: string };
    return body.code;
  }

  /**
   * The DS-08 / AX-01 fixture board: one session per state treatment (DESIGN.md 4),
   * plus the lost row, which is an agentless session last updated 13 h ago (the
   * liveness sweeper marks it lost; lostAfterHours is 12).
   */
  async seedBoard(): Promise<void> {
    await this.send("SessionStart", { source: "startup" }, { session: "board-starting" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-working" });
    await this.send("UserPromptSubmit", { prompt: "Refactor the focus path" }, { session: "board-working" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-permission" });
    await this.send("PermissionRequest", { tool_name: "Bash" }, { session: "board-permission" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-input" });
    await this.send("Notification", { notification_type: "idle_prompt", message: "Waiting for input" }, { session: "board-input" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-done" });
    await this.send("Stop", { last_assistant_message: "Turn complete" }, { session: "board-done" });
    await this.send("SessionStart", { source: "resume" }, { session: "board-idle" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-error" });
    await this.send("StopFailure", { error: "Turn failed" }, { session: "board-error" });
    await this.send("SessionStart", { source: "startup" }, { session: "board-ended" });
    await this.send("SessionEnd", { reason: "logout" }, { session: "board-ended", sentAt: Date.now() });
    // Real clock, 13 h ago: older than lostAfterHours (12) so the sweeper marks it lost, and
    // younger than retainEndedHours (24) so the daemon does not prune it at once.
    await this.send("SessionStart", { source: "startup" }, {
      session: "board-lost",
      agentPid: null,
      sentAt: Date.now() - 13 * 3_600_000,
    });
  }
}
