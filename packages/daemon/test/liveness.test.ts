import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, IngestOrigin } from "@mc/contracts";
import { FakePlatform } from "@mc/platform";
import type { ConfigStore, DaemonDeps, SessionRecord } from "../src/internal.js";
import { createLiveness } from "../src/liveness.js";

const HOUR_MS = 3_600_000;
const T0 = Date.parse("2026-11-12T12:00:00.000Z");

function record(
  id: string,
  opts: { state?: Session["state"]; pid?: number | null; startTime?: string | null; updatedAt?: string },
): SessionRecord {
  const pid = opts.pid === undefined ? 42 : opts.pid;
  const session = {
    id,
    state: opts.state ?? "working",
    updatedAt: opts.updatedAt ?? new Date(T0).toISOString(),
    process: { agentPid: pid, alive: pid === null ? null : true },
  } as unknown as Session;
  const origin = pid === null
    ? null
    : ({ agent: { pid, startTime: opts.startTime ?? null } } as unknown as IngestOrigin);
  return { session, cursor: { lastAppliedSentAt: 0 }, origin, target: null };
}

class FakeSessions {
  applied: unknown[] = [];
  constructor(public list: SessionRecord[]) {}
  records(): SessionRecord[] {
    return this.list;
  }
  get(id: string): SessionRecord | undefined {
    return this.list.find((r) => r.session.id === id);
  }
  apply(ev: unknown): undefined {
    this.applied.push(ev);
    return undefined;
  }
}

function deps(opts: {
  now: () => number;
  sessions: FakeSessions;
  platform: FakePlatform;
  intervalSeconds?: number;
  lostAfterHours?: number;
}): Pick<DaemonDeps, "clock" | "config" | "sessions" | "platform"> {
  const config = {
    get: () => ({
      sessions: {
        livenessIntervalSeconds: opts.intervalSeconds ?? 5,
        lostAfterHours: opts.lostAfterHours ?? 12,
      },
    }),
  } as unknown as ConfigStore;
  return {
    clock: { now: opts.now },
    config,
    sessions: opts.sessions as unknown as DaemonDeps["sessions"],
    platform: opts.platform,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("liveness", () => {
  it("LV-01 a dead pid produces process_exited within one interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const sessions = new FakeSessions([record("s1", { pid: 42 })]);
    const platform = new FakePlatform({ alivePids: new Set<number>() });
    const liveness = createLiveness(deps({ now: () => Date.now(), sessions, platform, intervalSeconds: 5 }));

    liveness.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sessions.applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.applied).toEqual([{ kind: "process_exited", sessionId: "s1", at: T0 + 5_000 }]);
    liveness.stop();
  });

  it("LV-02 a pid alive with a different start time counts as dead", async () => {
    const sessions = new FakeSessions([
      record("reused", { pid: 42, startTime: "start-B" }),
      record("same", { pid: 43, startTime: "start-C" }),
    ]);
    const platform = new FakePlatform({
      alivePids: new Set<number>([42, 43]),
      startTimes: { 42: "start-A", 43: "start-C" },
    });
    const liveness = createLiveness(deps({ now: () => T0, sessions, platform }));

    await liveness.checkNow();
    expect(sessions.applied).toEqual([{ kind: "process_exited", sessionId: "reused", at: T0 }]);
  });

  it("LV-03 no pid and no event for lostAfterHours produces lost_timeout", async () => {
    const stale = new Date(T0 - 12 * HOUR_MS - 60_000).toISOString();
    const fresh = new Date(T0 - 11 * HOUR_MS).toISOString();
    const sessions = new FakeSessions([
      record("stale", { pid: null, updatedAt: stale }),
      record("fresh", { pid: null, updatedAt: fresh }),
    ]);
    const platform = new FakePlatform();
    const liveness = createLiveness(deps({ now: () => T0, sessions, platform, lostAfterHours: 12 }));

    await liveness.checkNow();
    expect(sessions.applied).toEqual([{ kind: "lost_timeout", sessionId: "stale", at: T0 }]);
  });

  it("LV-04 ended sessions are not checked", async () => {
    const sessions = new FakeSessions([
      record("ended", { state: "ended", pid: 42 }),
      record("lost", { state: "lost", pid: null, updatedAt: new Date(T0 - 99 * HOUR_MS).toISOString() }),
    ]);
    const platform = new FakePlatform({ alivePids: new Set<number>() });
    const liveness = createLiveness(deps({ now: () => T0, sessions, platform }));

    await liveness.checkNow();
    expect(platform.calls.filter((c) => c.method === "processAlive")).toEqual([]);
    expect(sessions.applied).toEqual([]);
  });
});
