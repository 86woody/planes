import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Host, IngestEnvelope, Session } from "@mc/contracts";
import type { CoreEvent } from "@mc/core";
import type { ResolvedTarget } from "@mc/platform";
import { createSessionService } from "../src/sessions.js";
import type { ConfigStore, PersistedState, Persistence, SessionChange } from "../src/internal.js";

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

function envelope(event: string, nativeSessionId: string, sentAt: number, payload: IngestEnvelope["payload"] = {}): IngestEnvelope {
  return {
    v: 1,
    adapter: "claude-code",
    event,
    nativeSessionId,
    sentAt,
    seq: 0,
    payload,
    origin: {
      os: "windows",
      hookPid: 5151,
      agent: { pid: 4242, name: "claude.exe" },
      ancestry: [],
      tty: null,
      env: {},
      console: { consoleHwnd: "0x1", ownerHwnd: "0x2" },
    },
  } as IngestEnvelope;
}

function memConfig(overrides: Partial<Config> = {}): ConfigStore {
  const cfg = {
    notifications: { on: { done: true } },
    sessions: { retainEndedHours: 24, capturePromptText: true },
    adapters: { "claude-code": { enabled: true }, shell: { enabled: false, notifyAfterSeconds: 60 } },
    ...overrides,
  } as Config;
  return {
    get: () => cfg,
    error: () => null,
    onChange: () => () => {},
    close: () => {},
  };
}

function memPersistence() {
  const appended: { env: IngestEnvelope; receivedAt: number }[] = [];
  let saves = 0;
  let getState: (() => PersistedState) | null = null;
  return {
    appended,
    async load(): Promise<PersistedState> {
      return { version: 1, callsignCounter: 0, records: [] };
    },
    scheduleSave(get: () => PersistedState) {
      saves += 1;
      getState = get;
    },
    async flush() {},
    appendEvent(env: IngestEnvelope, receivedAt: number) {
      appended.push({ env, receivedAt });
    },
    async readSpool() {
      return [];
    },
    async deleteSpool() {},
    saves: () => saves,
    snapshot: (): PersistedState => {
      if (!getState) throw new Error("no save scheduled");
      return getState();
    },
  } satisfies Persistence & {
    appended: typeof appended;
    saves: () => number;
    snapshot: () => PersistedState;
  };
}

function setup(configOverrides: Partial<Config> = {}, initial: PersistedState = { version: 1, callsignCounter: 0, records: [] }) {
  const config = memConfig(configOverrides);
  const persistence = memPersistence();
  const clock = { now: () => Date.now() };
  const svc = createSessionService({ clock, config, persistence, initial });
  const changes: SessionChange[] = [];
  svc.onChange((c) => changes.push(c));
  return { svc, config, persistence, changes };
}

beforeEach(() => {
  vi.useFakeTimers({ now: BASE });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionService", () => {
  it("SS-01 first SessionStart creates a session MC-01 and emits one upsert with seq 1", () => {
    const { svc, changes } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup", cwd: "C:\\w\\proj" }), BASE);
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]?.callsign).toBe("MC-01");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "upsert", seq: 1 });
  });

  it("SS-02 events with no public change emit nothing", () => {
    const { svc, changes } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    const before = changes.length;
    const ackEv: CoreEvent = { kind: "ack", sessionId: "claude-code:a", at: BASE + 1 };
    svc.apply(ackEv);
    expect(changes.length).toBe(before);
  });

  it("SS-03 seq increases by one across upserts and removes", () => {
    const { svc, changes } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    svc.ingest(envelope("UserPromptSubmit", "a", BASE + 1000, { prompt: "hi" }), BASE + 1000);
    svc.remove("claude-code:a");
    svc.ingest(envelope("SessionStart", "b", BASE + 2000, { source: "startup" }), BASE + 2000);
    expect(changes.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(svc.seq()).toBe(4);
  });

  it("SS-04 disabled adapter is ignored", () => {
    const { svc, persistence, changes } = setup({
      adapters: { "claude-code": { enabled: false }, shell: { enabled: false, notifyAfterSeconds: 60 } },
    } as Partial<Config>);
    const r = svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    expect(r.sessionId).toBe("claude-code:a");
    expect(svc.list()).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(persistence.appended).toHaveLength(0);
  });

  it("SS-05 ack via apply marks attention acknowledged and emits", () => {
    const { svc, changes } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    svc.ingest(envelope("PermissionRequest", "a", BASE + 1000, { tool_name: "Bash" }), BASE + 1000);
    const before = changes.length;
    const s = svc.apply({ kind: "ack", sessionId: "claude-code:a", at: BASE + 2000 });
    expect(s?.attention.acknowledged).toBe(true);
    expect(changes.length).toBe(before + 1);
    expect(changes[changes.length - 1]).toMatchObject({ type: "upsert" });
  });

  it("SS-06 setRestore updates host and restore and keeps the target in the record", () => {
    const { svc } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    const first = svc.list()[0];
    if (!first) throw new Error("no session");
    const host = { ...first.host, kind: "windows-terminal" } as Host;
    const restore: Session["restore"] = { capability: "window", reason: null, lastResult: null };
    const target = { window: null, inner: null, capability: "window" } as unknown as ResolvedTarget;
    svc.setRestore("claude-code:a", host, restore, target);
    const rec = svc.get("claude-code:a");
    expect(rec?.session.host.kind).toBe("windows-terminal");
    expect(rec?.session.restore.capability).toBe("window");
    expect(rec?.target).toBe(target);
  });

  it("SS-07 remove emits a remove change and the session is gone from list()", () => {
    const { svc, changes } = setup();
    svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    expect(svc.remove("claude-code:a")).toBe(true);
    expect(changes[changes.length - 1]).toMatchObject({ type: "remove", id: "claude-code:a" });
    expect(svc.list()).toHaveLength(0);
    expect(svc.get("claude-code:a")).toBeUndefined();
  });

  it("SS-08 ended sessions older than retainEndedHours are pruned", () => {
    const { svc, changes } = setup({ sessions: { retainEndedHours: 1, capturePromptText: true } } as Partial<Config>);
    svc.ingest(envelope("SessionStart", "dead", BASE, { source: "startup" }), BASE);
    svc.ingest(envelope("SessionEnd", "dead", BASE, { reason: "clear" }), BASE);
    svc.ingest(envelope("SessionStart", "live", BASE, { source: "startup" }), BASE);
    expect(svc.list().map((s) => s.id).sort()).toEqual(["claude-code:dead", "claude-code:live"]);
    vi.advanceTimersByTime(2 * HOUR);
    expect(svc.list().map((s) => s.id)).toEqual(["claude-code:live"]);
    expect(changes.some((c) => c.type === "remove" && c.id === "claude-code:dead")).toBe(true);
  });

  it("SS-09 restored state from PersistedState keeps callsigns and the counter continues", () => {
    const first = setup();
    first.svc.ingest(envelope("SessionStart", "a", BASE, { source: "startup" }), BASE);
    const state = first.persistence.snapshot();
    expect(state.callsignCounter).toBe(1);

    const second = setup({}, state);
    expect(second.svc.list()[0]?.callsign).toBe("MC-01");
    second.svc.ingest(envelope("SessionStart", "b", BASE + 1000, { source: "startup" }), BASE + 1000);
    expect(second.svc.get("claude-code:b")?.session.callsign).toBe("MC-02");
  });

  it("SS-10 every ingest calls appendEvent and scheduleSave", () => {
    const { svc, persistence } = setup();
    const env = envelope("SessionStart", "a", BASE, { source: "startup" });
    svc.ingest(env, BASE + 5);
    expect(persistence.appended).toEqual([{ env, receivedAt: BASE + 5 }]);
    expect(persistence.saves()).toBe(1);
  });
});
