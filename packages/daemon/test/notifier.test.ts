import type { Session, SessionId } from "@mc/contracts";
import { FakePlatform } from "@mc/platform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifier } from "../src/notifier.js";
import type { DaemonDeps, SessionChange, SessionRecord } from "../src/internal.js";

// Minimal in-memory SessionService double. Only what the notifier touches.
function makeSessions() {
  const records = new Map<SessionId, SessionRecord>();
  const listeners = new Set<(c: SessionChange) => void>();
  const applied: unknown[] = [];
  const double = {
    onChange(cb: (c: SessionChange) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get(id: SessionId) {
      return records.get(id);
    },
    list(): Session[] {
      return [...records.values()].map((r) => r.session);
    },
    apply(ev: unknown) {
      applied.push(ev);
      return undefined;
    },
  };
  return {
    double,
    applied,
    /** Store a session and emit an upsert the way SessionService does. */
    upsert(next: Session, windowHandle: string | null = "0xA") {
      const prev = records.get(next.id)?.session;
      records.set(next.id, {
        session: next,
        cursor: { lastAppliedSentAt: 0 },
        origin: null,
        target:
          windowHandle === null
            ? null
            : {
                window: { os: "linux", handle: windowHandle, pid: 1, app: "FakeTerm", title: "t" },
                inner: null,
                capability: "full",
                reason: null,
              },
      });
      for (const cb of listeners) cb({ type: "upsert", prev, next, seq: 0 });
    },
  };
}

function makeSession(id: string, over: Partial<Session["attention"]> = {}): Session {
  return {
    id: id as SessionId,
    adapter: "claude-code",
    nativeId: "n-" + id,
    callsign: "ALPHA-1",
    title: "title " + id,
    cwd: "/w/" + id,
    project: "proj-" + id,
    branch: null,
    state: "needs_permission",
    attention: {
      active: true,
      reason: "permission",
      since: "2026-11-12T10:00:00.000Z",
      acknowledged: false,
      message: null,
      ...over,
    },
    startedAt: "2026-11-12T09:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
    lastEvent: { name: "PermissionRequest", at: "2026-11-12T10:00:00.000Z", summary: "" },
    process: { agentPid: null, alive: null },
    host: {
      kind: "linux-terminal",
      app: "FakeTerm",
      os: "linux",
      display: "x11",
      multiplexer: null,
    },
    restore: { capability: "full", reason: null, lastResult: null },
    stats: { prompts: 0, tools: 0, notifications: 0, events: 0 },
    endReason: null,
  } as Session;
}

const CONFIG = {
  notifications: {
    enabled: true,
    on: { permission: true, input: true, error: true, done: true },
    suppressWhenFocused: true,
    quietHours: null,
    renotifyMinutes: 1,
    sound: false,
  },
};

function setup(opts: { foreground?: string | null } = {}) {
  const sessionsDouble = makeSessions();
  const platform = new FakePlatform({ foregroundSessionWindow: opts.foreground ?? null });
  const broadcast = vi.fn();
  const restore = vi.fn(async () => ({ status: "failed", code: "not_found", detail: "", at: "" }));
  const focus = { resolve: vi.fn(), restore };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = {
    clock: { now: () => Date.now() },
    log,
    config: { get: () => CONFIG, error: () => null, onChange: () => () => {}, close: () => {} },
    sessions: sessionsDouble.double,
    platform,
    focus,
    broadcast,
  } as unknown as Pick<
    DaemonDeps,
    "clock" | "log" | "config" | "sessions" | "platform" | "focus" | "broadcast"
  >;
  const notifier = createNotifier(deps);
  return { notifier, sessionsDouble, platform, broadcast, restore, focus, log };
}

/** Let queued async notifier work run under fake timers. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

const notifyCalls = (p: FakePlatform) => p.calls.filter((c) => c.method === "notify");

describe("notifier (attention.md 6, internal.md Notifier)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("NT-01 attention entry sends one platform.notify, one broadcast notify and one notified apply", async () => {
    const { notifier, sessionsDouble, platform, broadcast } = setup();
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();

    expect(notifyCalls(platform)).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "notify",
        notification: expect.objectContaining({ sessionId: "s1", urgency: "critical" }),
      }),
    );
    expect(sessionsDouble.applied).toEqual([{ kind: "notified", sessionId: "s1", at: Date.now() }]);
    notifier.stop();
  });

  it("NT-02 the same attention updated again sends nothing", async () => {
    const { notifier, sessionsDouble, platform, broadcast } = setup();
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();
    platform.calls.length = 0;
    broadcast.mockClear();

    sessionsDouble.upsert(makeSession("s1"));
    await settle();

    expect(notifyCalls(platform)).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
    notifier.stop();
  });

  it("NT-03 foreground session window suppresses the notification", async () => {
    const { notifier, sessionsDouble, platform, broadcast } = setup({ foreground: "0xA" });
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();

    expect(notifyCalls(platform)).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
    notifier.stop();
  });

  it("NT-04 attention clearing withdraws the shown notification", async () => {
    const { notifier, sessionsDouble, platform } = setup();
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();
    expect(notifyCalls(platform)).toHaveLength(1);

    sessionsDouble.upsert(makeSession("s1", { active: false, reason: null, since: null }));
    await settle();

    expect(platform.calls.filter((c) => c.method === "withdraw")).toHaveLength(1);
    notifier.stop();
  });

  it("NT-05 click calls focus.restore with source notification; failed result broadcasts highlight", async () => {
    const { notifier, sessionsDouble, platform, broadcast, restore } = setup();
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();
    broadcast.mockClear();

    platform.click("s1");
    await settle();
    expect(restore).toHaveBeenCalledWith("s1", "notification");
    expect(broadcast).toHaveBeenCalledWith({ type: "highlight", sessionId: "s1" });

    platform.click(null);
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
    notifier.stop();
  });

  it("NT-06 renotify after renotifyMinutes for unacknowledged attention", async () => {
    const { notifier, sessionsDouble, platform } = setup();
    notifier.start();
    sessionsDouble.upsert(makeSession("s1"));
    await settle();
    expect(notifyCalls(platform)).toHaveLength(1);

    // renotifyMinutes is 1: the 30 s tick at +30 s is too early, the one at +60 s sends.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notifyCalls(platform)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notifyCalls(platform)).toHaveLength(2);
    notifier.stop();
  });

  it("NT-07 a burst of 5 attentions sends 3 then one summary after 5 s", async () => {
    const { notifier, sessionsDouble, platform, broadcast } = setup();
    notifier.start();
    for (const id of ["a", "b", "c", "d", "e"]) sessionsDouble.upsert(makeSession(id));
    await settle();

    expect(notifyCalls(platform)).toHaveLength(3);
    expect(broadcast).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    const calls = notifyCalls(platform);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.args).toEqual([
      expect.objectContaining({
        sessionId: null,
        title: "MISSION CONTROL",
        body: "2 sessions need attention",
      }),
    ]);
    notifier.stop();
  });

  it("NT-08 test() sends the COMMS CHECK notification", async () => {
    const { notifier, platform } = setup();
    const result = await notifier.test();

    expect(result).toEqual({ sent: true, backend: "os" });
    const call = notifyCalls(platform)[0];
    expect(call?.args).toEqual([
      {
        sessionId: null,
        title: "MISSION CONTROL · COMMS CHECK",
        body: "Notifications are GO",
        urgency: "normal",
        tag: "test",
      },
    ]);
    notifier.stop();
  });
});
