import { describe, expect, it } from "vitest";
import type { Config, Host, IngestOrigin, ProcessInfo, Session, SessionId } from "@mc/contracts";
import { classifyHost, type CoreEvent } from "@mc/core";
import { FakePlatform, type NativeWindow, type ResolvedTarget } from "@mc/platform";
import type { BridgeWindow, BridgeRegistry, DaemonDeps, Logger, SessionRecord, SessionService } from "../src/internal.js";
import { createFocusService } from "../src/focus.js";

const ID = "claude-code:fixture-1" as SessionId;

const proc = (pid: number, name: string): ProcessInfo => ({ pid, name, startTime: String(pid) });
const claude = proc(100, "claude.exe");
const pwsh = proc(101, "pwsh.exe");
const code = proc(103, "Code.exe");
const wt = proc(104, "WindowsTerminal.exe");

function origin(env: IngestOrigin["env"], ancestry: ProcessInfo[]): IngestOrigin {
  return {
    os: "windows",
    hookPid: 9999,
    agent: ancestry.find((p) => p.pid === 100) ?? null,
    ancestry,
    tty: null,
    env,
    console: { consoleHwnd: null, ownerHwnd: null },
  } as unknown as IngestOrigin;
}

const winTerm = () => origin({ WT_SESSION: "abc" }, [claude, wt]);
const vsTerm = () => origin({}, [claude, pwsh, code]);

const windowOf = (handle: string, title: string): NativeWindow => ({
  os: "windows",
  handle,
  pid: 555,
  app: "Code.exe",
  title,
});

const BOUND = windowOf("0x0000000000001234", "index.ts - repo - Visual Studio Code");

function bridgeWindow(over: Partial<BridgeWindow> = {}): BridgeWindow {
  return {
    windowId: "win-1",
    extHostPid: 555,
    workspaceName: "repo",
    workspaceFolders: [],
    remoteName: null,
    terminals: [{ terminalId: "t1", name: "pwsh", shellPid: 101, active: true }],
    nativeWindow: null,
    ...over,
  };
}

const cfg = {
  restore: { maximize: "if-minimized", ackOnRestore: false, windowsForegroundStrategy: "plain" },
} as unknown as Config;

const log: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const clock = { now: () => 1_700_000_000_000 };

/** Session store double: holds one record, records setRestore and apply calls. */
class FakeSessions {
  rec: SessionRecord;
  restores: { host: Host; restore: Session["restore"]; target: ResolvedTarget | null }[] = [];
  applied: CoreEvent[] = [];

  constructor(rec: SessionRecord) {
    this.rec = rec;
  }

  get = (id: SessionId): SessionRecord | undefined => (id === this.rec.session.id ? this.rec : undefined);

  setRestore = (id: SessionId, host: Host, restore: Session["restore"], target: ResolvedTarget | null): void => {
    if (id !== this.rec.session.id) return;
    this.restores.push({ host, restore, target });
    this.rec = { ...this.rec, session: { ...this.rec.session, host, restore }, target };
  };

  apply = (ev: CoreEvent): undefined => {
    this.applied.push(ev);
    return undefined;
  };
}

/** Bridge registry double: one optional matching window, scripted request reply. */
class FakeBridges {
  found: { window: BridgeWindow; terminalId: string | null } | undefined;
  requestOk = true;
  requestDetail = "terminal shown";
  requests: { windowId: string; msg: unknown }[] = [];
  rebinds: { windowId: string; w: NativeWindow | null }[] = [];

  findForSession = () => this.found;

  request = async (windowId: string, msg: unknown) => {
    this.requests.push({ windowId, msg });
    return { ok: this.requestOk, detail: this.requestDetail };
  };

  rebind = (windowId: string, w: NativeWindow | null): void => {
    this.rebinds.push({ windowId, w });
  };
}

/** FakePlatform whose listWindows returns a scripted list (for the VS Code title fallback). */
class TitlePlatform extends FakePlatform {
  windows: NativeWindow[] = [];

  override async listWindows(): Promise<NativeWindow[]> {
    return this.windows;
  }
}

function build(o: IngestOrigin, state: Session["state"] = "working", project = "repo", platform = new TitlePlatform()) {
  const session = {
    id: ID,
    adapter: "claude-code",
    nativeId: "fixture-1",
    callsign: "MC-01",
    title: "fixture",
    cwd: "C:\\work\\repo",
    project,
    branch: null,
    state,
    attention: { active: false, reason: null, since: null, acknowledged: false, message: null },
    startedAt: "2026-11-08T20:15:03.120Z",
    updatedAt: "2026-11-08T20:15:03.120Z",
    lastEvent: { name: "Stop", at: "2026-11-08T20:15:03.120Z", summary: "Idle" },
    process: { agentPid: 100, alive: true },
    host: classifyHost(o),
    restore: { capability: "none", reason: "no_window_found", lastResult: null },
    stats: { prompts: 0, tools: 0, notifications: 0, events: 0 },
    endReason: null,
  } as unknown as Session;
  const rec: SessionRecord = { session, cursor: { lastAppliedSentAt: 0 }, origin: o, target: null };
  const sessions = new FakeSessions(rec);
  const bridges = new FakeBridges();
  const svc = createFocusService({
    clock,
    log,
    config: { get: () => cfg } as unknown as DaemonDeps["config"],
    sessions: sessions as unknown as SessionService,
    platform,
    bridges: bridges as unknown as BridgeRegistry,
  });
  return { svc, sessions, platform, bridges };
}

describe("FocusService and target resolution", () => {
  it("FO-01 a windows-terminal session resolves through platform.resolveTarget and writes capability full", async () => {
    const { svc, sessions, platform } = build(winTerm());
    await svc.resolve(ID);
    expect(platform.calls.map((c) => c.method)).toEqual(["resolveTarget"]);
    expect(sessions.restores.at(-1)?.host.kind).toBe("windows-terminal");
    expect(sessions.restores.at(-1)?.restore.capability).toBe("full");
    expect(sessions.rec.target?.window?.handle).toBe("0xFAKE100");
  });

  it("FO-02 vscode-terminal with a bound bridge window resolves full and remembers the terminalId", async () => {
    const { svc, sessions, bridges } = build(vsTerm());
    bridges.found = { window: bridgeWindow({ nativeWindow: BOUND }), terminalId: "t1" };
    await svc.resolve(ID);
    expect(sessions.restores.at(-1)?.restore.capability).toBe("full");
    expect(sessions.rec.target?.window).toEqual(BOUND);
    const res = await svc.restore(ID, "page");
    expect(res.code).toBe("focused");
    expect(bridges.requests[0]).toEqual({
      windowId: "win-1",
      msg: { type: "focusTerminal", terminalId: "t1", maximizePanel: false },
    });
  });

  it("FO-03 vscode-terminal with an unbound bridge and a unique title match binds the window", async () => {
    const { svc, sessions, platform, bridges } = build(vsTerm());
    platform.windows = [BOUND, windowOf("0x0000000000005678", "notes.md - other - Visual Studio Code")];
    bridges.found = { window: bridgeWindow({ nativeWindow: null }), terminalId: "t1" };
    await svc.resolve(ID);
    expect(bridges.rebinds).toEqual([{ windowId: "win-1", w: BOUND }]);
    expect(sessions.restores.at(-1)?.restore.capability).toBe("full");
    expect(sessions.rec.target?.window).toEqual(BOUND);
  });

  it("FO-04 vscode-terminal without a bridge and a unique title match is window/vscode_bridge_missing", async () => {
    const { svc, sessions, platform } = build(vsTerm(), "working", "repo");
    platform.windows = [BOUND];
    await svc.resolve(ID);
    expect(sessions.restores.at(-1)?.restore).toEqual({
      capability: "window",
      reason: "vscode_bridge_missing",
      lastResult: null,
    });
    expect(sessions.rec.target?.window).toEqual(BOUND);
  });

  it("FO-05 ended session resolves to none/process_ended", async () => {
    const { svc, sessions, platform } = build(winTerm(), "ended");
    await svc.resolve(ID);
    expect(sessions.restores.at(-1)).toEqual({
      host: expect.objectContaining({ kind: "windows-terminal" }),
      restore: { capability: "none", reason: "process_ended", lastResult: null },
      target: null,
    });
    expect(platform.calls).toHaveLength(0);
  });

  it("FO-06 restore of a full target calls platform.focus with the config options and applies restore_result", async () => {
    const { svc, sessions, platform } = build(winTerm());
    await svc.resolve(ID);
    const res = await svc.restore(ID, "page");
    expect(res.status).toBe("ok");
    const focus = platform.calls.find((c) => c.method === "focus");
    expect(focus?.args).toEqual([
      sessions.rec.target,
      { maximize: "if-minimized", foregroundStrategy: "plain", fromActivation: false },
    ]);
    expect(sessions.applied).toEqual([
      { kind: "restore_result", sessionId: ID, result: res, ackOnRestore: false },
    ]);
  });

  it("FO-07 VS Code restore sends focusTerminal after the OS focus; bridge failure yields focused_window_only", async () => {
    const { svc, bridges } = build(vsTerm());
    bridges.found = { window: bridgeWindow({ nativeWindow: BOUND }), terminalId: "t1" };
    const ok = await svc.restore(ID, "page");
    expect(ok).toMatchObject({ status: "ok", code: "focused" });
    bridges.requestOk = false;
    bridges.requestDetail = "terminal_gone";
    const partial = await svc.restore(ID, "page");
    expect(partial).toMatchObject({ status: "partial", code: "focused_window_only", detail: "terminal_gone" });
    expect(bridges.requests).toHaveLength(2);
  });

  it("FO-08 not_found triggers one re-resolve and one retry", async () => {
    let focusCalls = 0;
    const platform = new TitlePlatform({ focusResult: "not_found" }, (c) => {
      if (c.method === "focus") {
        focusCalls += 1;
        if (focusCalls === 2) platform.setScript({ focusResult: "focused" });
      }
    });
    const { svc } = build(winTerm(), "working", "repo", platform);
    await svc.resolve(ID);
    const res = await svc.restore(ID, "page");
    expect(res).toMatchObject({ status: "ok", code: "focused" });
    expect(platform.calls.filter((c) => c.method === "resolveTarget")).toHaveLength(2);
    expect(platform.calls.filter((c) => c.method === "focus")).toHaveLength(2);
  });

  it("FO-09 capability none returns failed/unsupported without calling platform.focus", async () => {
    const { svc, platform } = build(winTerm());
    platform.setScript({
      resolve: () => ({ window: null, inner: null, capability: "none", reason: "no_window_found" }),
    });
    await svc.resolve(ID);
    const res = await svc.restore(ID, "page");
    expect(res).toMatchObject({ status: "failed", code: "unsupported", detail: "no_window_found" });
    expect(platform.calls.some((c) => c.method === "focus")).toBe(false);

    // D-17: a remote (SSH) session never reaches the platform; restore is failed/unsupported/remote_session.
    const remote = build(origin({ SSH_CONNECTION: "present" }, [claude, pwsh]));
    await remote.svc.resolve(ID);
    expect(remote.sessions.restores.at(-1)?.restore).toMatchObject({ capability: "none", reason: "remote_session" });
    expect(remote.platform.calls.some((c) => c.method === "resolveTarget")).toBe(false);
    const remoteRes = await remote.svc.restore(ID, "page");
    expect(remoteRes).toMatchObject({ status: "failed", code: "unsupported", detail: "remote_session" });
    expect(remote.platform.calls.some((c) => c.method === "focus")).toBe(false);
  });

  it("FO-10 concurrent restores of one session run platform.focus once", async () => {
    const { svc, platform } = build(winTerm());
    platform.setScript({ delayMs: 20 });
    await svc.resolve(ID);
    const [a, b] = await Promise.all([svc.restore(ID, "page"), svc.restore(ID, "page")]);
    expect(a).toEqual(b);
    expect(platform.calls.filter((c) => c.method === "focus")).toHaveLength(1);
  });
});
