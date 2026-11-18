import type { Session, Config, AttentionReason, OsNotification } from "@mc/contracts";

// attention.md section 6. Pure functions: the caller supplies time and quiet-hours minutes.
export interface NotifyContext {
  config: Config["notifications"];
  now: number; // epoch ms
  localMinutes: number; // minutes since local midnight, for quiet hours
  isForeground: boolean; // platform says this session's window is foreground
  lastSent: { reason: AttentionReason; at: number } | undefined; // for this session
}
export type NotifyDecision =
  | { send: true; notification: OsNotification }
  | {
      send: false;
      why:
        | "disabled"
        | "reason_disabled"
        | "no_change"
        | "acknowledged"
        | "focused"
        | "quiet_hours"
        | "dedupe"
        | "ended";
    };
type SkipWhy = Extract<NotifyDecision, { send: false }>["why"];

// Plain state words (DESIGN.md 4, D-48).
const LABEL: Record<AttentionReason, string> = {
  permission: "Needs permission",
  input: "Needs input",
  error: "Error",
  done: "Done",
};
const DEFAULT_BODY: Record<AttentionReason, string> = {
  permission: "Permission needed",
  input: "Waiting for your input",
  error: "Turn failed",
  done: "Turn complete",
};
const URGENCY: Record<AttentionReason, OsNotification["urgency"]> = {
  permission: "critical",
  input: "normal",
  error: "critical",
  done: "low",
};
const URGENCY_RANK: Record<OsNotification["urgency"], number> = { low: 0, normal: 1, critical: 2 };
const DEDUPE_MS = 10_000;
const WINDOW_MS = 5_000;
const MAX_PER_WINDOW = 3;

function truncate(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

function skip(why: SkipWhy): NotifyDecision {
  return { send: false, why };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// start inclusive, end exclusive, may wrap midnight. start === end is an empty window.
function inQuietHours(qh: { start: string; end: string }, localMinutes: number): boolean {
  const s = toMinutes(qh.start);
  const e = toMinutes(qh.end);
  if (s === e) return false;
  return s < e ? localMinutes >= s && localMinutes < e : localMinutes >= s || localMinutes < e;
}

// Quiet hours never silence a permission request (NP-09).
function isQuiet(ctx: NotifyContext, reason: AttentionReason): boolean {
  const qh = ctx.config.quietHours;
  return qh !== null && reason !== "permission" && inQuietHours(qh, ctx.localMinutes);
}

// NP-13, NP-14.
function build(s: Session, reason: AttentionReason): OsNotification {
  const message = s.attention.message;
  return {
    sessionId: s.id,
    title: truncate(`${s.callsign} · ${LABEL[reason]} · ${s.project}`, 64),
    body: truncate(message && message.length > 0 ? message : DEFAULT_BODY[reason], 180),
    urgency: URGENCY[reason],
    tag: s.id,
  };
}

export function decide(prev: Session | undefined, next: Session, ctx: NotifyContext): NotifyDecision {
  if (!ctx.config.enabled) return skip("disabled"); // NP-01
  if (next.state === "ended" || next.state === "lost") return skip("ended"); // NP-02
  const reason = next.attention.reason;
  if (!next.attention.active || reason === null) return skip("no_change"); // NP-03
  if (prev?.attention.active && prev.attention.reason === reason) return skip("no_change"); // NP-04
  if (!ctx.config.on[reason]) return skip("reason_disabled"); // NP-05
  if (next.attention.acknowledged) return skip("acknowledged"); // NP-06
  if (ctx.lastSent && ctx.lastSent.reason === reason && ctx.now - ctx.lastSent.at < DEDUPE_MS)
    return skip("dedupe"); // NP-07
  if (ctx.config.suppressWhenFocused && ctx.isForeground) return skip("focused"); // NP-08
  if (isQuiet(ctx, reason)) return skip("quiet_hours"); // NP-09
  return { send: true, notification: build(next, reason) }; // NP-10
}

export function decideRenotify(s: Session, ctx: NotifyContext): NotifyDecision {
  const cfg = ctx.config;
  const reason = s.attention.reason;
  if (!cfg.enabled || cfg.renotifyMinutes <= 0) return skip("disabled");
  if (s.state === "ended" || s.state === "lost") return skip("ended");
  if (!s.attention.active || reason === null) return skip("no_change");
  if (s.attention.acknowledged) return skip("acknowledged");
  if (!cfg.on[reason]) return skip("reason_disabled");
  if (cfg.suppressWhenFocused && ctx.isForeground) return skip("focused");
  if (isQuiet(ctx, reason)) return skip("quiet_hours");
  if (!ctx.lastSent || ctx.now - ctx.lastSent.at < cfg.renotifyMinutes * 60_000) return skip("dedupe"); // NP-11
  return { send: true, notification: build(s, reason) };
}

// NP-12: fixed windows. A window opens at the first offer after the previous one closed;
// at most MAX_PER_WINDOW pass through it, the rest are held and become one summary when
// the window closes. A window's summary is returned by flush() once now >= start + WINDOW_MS.
export class Coalescer {
  private windowStart: number | null = null;
  private sent = 0;
  private held: OsNotification[] = [];
  private due: OsNotification[] = [];

  /** Returns the notifications that may be shown now; the rest are held (NP-12). */
  offer(n: OsNotification, now: number): OsNotification[] {
    if (this.windowStart === null || now >= this.windowStart + WINDOW_MS) this.openWindow(now);
    if (this.sent < MAX_PER_WINDOW) {
      this.sent++;
      return [n];
    }
    this.held.push(n);
    return [];
  }

  /** Returns what is due when the window closes (held ones as one summary). */
  flush(now: number): OsNotification[] {
    if (this.held.length > 0 && this.windowStart !== null && now >= this.windowStart + WINDOW_MS) {
      this.closeWindow();
    }
    const out = this.due;
    this.due = [];
    return out;
  }

  private openWindow(now: number): void {
    if (this.held.length > 0) this.closeWindow();
    this.windowStart = now;
    this.sent = 0;
  }

  private closeWindow(): void {
    const urgency = this.held.reduce<OsNotification["urgency"]>(
      (u, n) => (URGENCY_RANK[n.urgency] > URGENCY_RANK[u] ? n.urgency : u),
      "low",
    );
    this.due.push({
      sessionId: null,
      title: "MISSION CONTROL",
      body: `${this.held.length} sessions need attention`,
      urgency,
      tag: "summary",
    });
    this.held = [];
  }
}
