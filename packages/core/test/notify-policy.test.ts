import { describe, expect, it } from "vitest";
import type { Attention, Config, OsNotification, Session, State } from "@mc/contracts";
import { Coalescer, decide, decideRenotify, type NotifyContext } from "../src/notify-policy.js";

import needsPermission from "../../contracts/fixtures/sessions/needs_permission.json" with { type: "json" };
import needsInput from "../../contracts/fixtures/sessions/needs_input.json" with { type: "json" };

const FIXTURES: Record<string, unknown> = { needs_permission: needsPermission, needs_input: needsInput };
function fixture(name: string): Session {
  // JSON imports, not fs: packages/core forbids node built-ins (eslint.config.js).
  return structuredClone(FIXTURES[name]) as Session;
}

function withAttention(s: Session, attention: Partial<Attention>, state?: State): Session {
  return { ...s, state: state ?? s.state, attention: { ...s.attention, ...attention } };
}

const CFG: Config["notifications"] = {
  enabled: true,
  on: { permission: true, input: true, error: true, done: true },
  suppressWhenFocused: true,
  quietHours: null,
  renotifyMinutes: 0,
  sound: true,
};

function ctx(over: Partial<NotifyContext> = {}, cfg: Partial<Config["notifications"]> = {}): NotifyContext {
  return {
    config: { ...CFG, ...cfg },
    now: 100_000,
    localMinutes: 720,
    isForeground: false,
    lastSent: undefined,
    ...over,
  };
}

const PERMISSION = (): Session => withAttention(fixture("needs_permission"), { active: true, reason: "permission", acknowledged: false });
const INPUT = (): Session => withAttention(fixture("needs_input"), { active: true, reason: "input", acknowledged: false, message: null }, "needs_input");

function sent(d: ReturnType<typeof decide>): OsNotification {
  if (!d.send) throw new Error(`expected send, got ${d.why}`);
  return d.notification;
}

function note(id: string, urgency: OsNotification["urgency"] = "normal"): OsNotification {
  return { sessionId: id, title: `t-${id}`, body: "b", urgency, tag: id };
}

describe("notify policy", () => {
  it("NP-01 notifications disabled in config suppresses everything", () => {
    const d = decide(undefined, PERMISSION(), ctx({}, { enabled: false }));
    expect(d).toEqual({ send: false, why: "disabled" });
  });

  it("NP-02 ended or lost sessions never notify", () => {
    for (const state of ["ended", "lost"] as const) {
      const s = withAttention(PERMISSION(), {}, state);
      expect(decide(undefined, s, ctx())).toEqual({ send: false, why: "ended" });
    }
  });

  it("NP-03 inactive attention is no change", () => {
    const s = withAttention(PERMISSION(), { active: false, reason: null });
    expect(decide(undefined, s, ctx())).toEqual({ send: false, why: "no_change" });
  });

  it("NP-04 same reason already active before is no change", () => {
    const prev = PERMISSION();
    expect(decide(prev, PERMISSION(), ctx())).toEqual({ send: false, why: "no_change" });
  });

  it("NP-05 reason switched off in config is reason_disabled", () => {
    const cfg = { on: { permission: false, input: true, error: true, done: true } };
    expect(decide(undefined, PERMISSION(), ctx({}, cfg))).toEqual({ send: false, why: "reason_disabled" });
  });

  it("NP-06 acknowledged attention does not notify", () => {
    const s = withAttention(PERMISSION(), { acknowledged: true });
    expect(decide(undefined, s, ctx())).toEqual({ send: false, why: "acknowledged" });
  });

  it("NP-07 same reason within 10 s is a dedupe, after 10 s it sends", () => {
    const at = 100_000;
    expect(decide(undefined, PERMISSION(), ctx({ now: at + 9_999, lastSent: { reason: "permission", at } }))).toEqual({
      send: false,
      why: "dedupe",
    });
    const d = decide(undefined, PERMISSION(), ctx({ now: at + 10_000, lastSent: { reason: "permission", at } }));
    expect(d.send).toBe(true);
  });

  it("NP-08 suppressWhenFocused with a foreground window is focused", () => {
    expect(decide(undefined, PERMISSION(), ctx({ isForeground: true }))).toEqual({ send: false, why: "focused" });
    expect(decide(undefined, PERMISSION(), ctx({ isForeground: true }, { suppressWhenFocused: false })).send).toBe(true);
  });

  it("NP-09 quiet hours 22:00-07:00 wrap: 23:30 and 06:59 suppressed, 07:00 sent, permission sent", () => {
    const qh = { quietHours: { start: "22:00", end: "07:00" } };
    const inputAt = (m: number) => decide(undefined, INPUT(), ctx({ localMinutes: m }, qh));
    expect(inputAt(23 * 60 + 30)).toEqual({ send: false, why: "quiet_hours" });
    expect(inputAt(6 * 60 + 59)).toEqual({ send: false, why: "quiet_hours" });
    expect(inputAt(7 * 60).send).toBe(true);
    expect(decide(undefined, PERMISSION(), ctx({ localMinutes: 23 * 60 + 30 }, qh)).send).toBe(true);
  });

  it("NP-10 attention becoming active, or its reason changing, sends", () => {
    const d1 = decide(undefined, PERMISSION(), ctx());
    expect(d1.send).toBe(true);
    const prev = INPUT();
    const d2 = decide(prev, PERMISSION(), ctx());
    expect(d2.send).toBe(true);
  });

  it("NP-11 renotify after renotifyMinutes while still unacknowledged, otherwise not", () => {
    const cfg = { renotifyMinutes: 5 };
    const last = { reason: "permission" as const, at: 0 };
    const tooSoon = decideRenotify(PERMISSION(), ctx({ now: 5 * 60_000 - 1, lastSent: last }, cfg));
    expect(tooSoon.send).toBe(false);
    const due = decideRenotify(PERMISSION(), ctx({ now: 5 * 60_000, lastSent: last }, cfg));
    expect(due.send).toBe(true);
    const acked = decideRenotify(withAttention(PERMISSION(), { acknowledged: true }), ctx({ now: 9e9, lastSent: last }, cfg));
    expect(acked.send).toBe(false);
    const never = decideRenotify(PERMISSION(), ctx({ now: 9e9, lastSent: undefined }, cfg));
    expect(never.send).toBe(false);
    const off = decideRenotify(PERMISSION(), ctx({ now: 9e9, lastSent: last }));
    expect(off.send).toBe(false);
  });

  it("NP-12 coalescer: 3 pass per 5 s window, rest become one summary when it closes", () => {
    const c = new Coalescer();
    const out: OsNotification[] = [];
    const urgencies: OsNotification["urgency"][] = ["critical", "normal", "low", "low", "normal"];
    for (let t = 0; t < 5; t++) out.push(...c.offer(note(`s${t}`, urgencies[t]), t));
    expect(out).toHaveLength(3);
    expect(c.flush(4999)).toEqual([]);
    const due = c.flush(5000);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ sessionId: null, title: "MISSION CONTROL", body: "2 sessions need attention", urgency: "normal" });
    expect(c.flush(5000)).toEqual([]);
  });

  it("NP-13 title and body are built from the label map and truncated by code points", () => {
    const d = sent(decide(undefined, PERMISSION(), ctx()));
    expect(d.title).toBe("MC-03 · Needs permission · project");
    expect(d.body).toBe("Claude needs permission to use Bash");
    expect(d.urgency).toBe("critical");

    const long = withAttention(PERMISSION(), { message: "😀".repeat(300) });
    const dl = sent(decide(undefined, long, ctx()));
    expect(Array.from(dl.body)).toHaveLength(180);
    expect(Array.from(dl.title).length).toBeLessThanOrEqual(64);

    const input = sent(decide(undefined, INPUT(), ctx()));
    expect(input.title).toBe(`${INPUT().callsign} · Needs input · project`);
    expect(input.body).toBe("Waiting for your input");
    expect(input.urgency).toBe("normal");
  });

  it("NP-14 OsNotification shape: sessionId, tag = session id, urgency per reason", () => {
    const d = sent(decide(undefined, PERMISSION(), ctx()));
    expect(Object.keys(d).sort()).toEqual(["body", "sessionId", "tag", "title", "urgency"]);
    expect(d.sessionId).toBe("claude-code:fixture-needs_permission");
    expect(d.tag).toBe(d.sessionId);
  });
});
