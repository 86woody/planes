import type { Session } from "@mc/contracts";

const time = (iso: string | null): number => (iso === null ? Number.POSITIVE_INFINITY : Date.parse(iso));
const isDead = (s: Session): boolean => s.state === "ended" || s.state === "lost";

/** DESIGN.md 2 list order; lower sorts first. */
function rank(s: Session): number {
  switch (s.state) {
    case "needs_permission":
      return 0;
    case "error":
      return 1;
    case "needs_input":
      return 2;
    case "idle":
      return s.attention.active && s.attention.reason === "done" ? 3 : 6;
    case "working":
      return 4;
    case "starting":
      return 5;
    default:
      return 7;
  }
}

/** Live groups by rank, then attention.since oldest first, then startedAt newest first. */
function byGroupThenSince(a: Session, b: Session): number {
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  const since = time(a.attention.since) - time(b.attention.since);
  if (since !== 0 && !Number.isNaN(since)) return since;
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

/** Ended and lost sessions, most recently updated first. */
function byUpdated(a: Session, b: Session): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** The list view: live sessions in rank order, and the ended/lost group. */
export function sortSessions(s: Session[]): { live: Session[]; splashdown: Session[] } {
  const live: Session[] = [];
  const splashdown: Session[] = [];
  for (const session of s) {
    if (isDead(session)) splashdown.push(session);
    else live.push(session);
  }
  live.sort(byGroupThenSince);
  splashdown.sort(byUpdated);
  return { live, splashdown };
}

/** Active, unacknowledged attention: permission/error, then input, then done; oldest first. */
export function pollItems(s: Session[]): Session[] {
  const reasonRank = (x: Session): number => {
    switch (x.attention.reason) {
      case "permission":
      case "error":
        return 0;
      case "input":
        return 1;
      default:
        return 2;
    }
  };
  return s
    .filter((x) => x.attention.active && !x.attention.acknowledged && x.attention.reason !== null)
    .sort((a, b) => {
      const r = reasonRank(a) - reasonRank(b);
      if (r !== 0) return r;
      return time(a.attention.since) - time(b.attention.since);
    });
}

/** Alerts the user dismissed in this page, keyed by session id, valued by attention.since. */
export type Dismissed = Record<string, string | null>;

/** A session needs you: live, attention active, and its current alert not dismissed. */
export function needsYou(s: Session, dismissed: Dismissed = {}): boolean {
  if (isDead(s) || !s.attention.active) return false;
  return !(s.id in dismissed && dismissed[s.id] === s.attention.since);
}

/** The Needs you stack: unacknowledged first, then the longest wait first. */
export function needsStack(s: Session[], dismissed: Dismissed = {}): Session[] {
  return s
    .filter((x) => needsYou(x, dismissed))
    .sort(
      (a, b) =>
        Number(a.attention.acknowledged) - Number(b.attention.acknowledged) ||
        time(a.attention.since) - time(b.attention.since),
    );
}

/** DESIGN.md 3 readiness: live = not ended; fine = live, not needing you, not error, not lost. */
export function counts(s: Session[], dismissed: Dismissed = {}): {
  live: number;
  fine: number;
  needs: number;
  errors: number;
  lost: number;
  ended: number;
} {
  const out = { live: 0, fine: 0, needs: 0, errors: 0, lost: 0, ended: 0 };
  for (const x of s) {
    if (x.state === "ended") {
      out.ended += 1;
      continue;
    }
    out.live += 1;
    const needs = needsYou(x, dismissed);
    if (needs) out.needs += 1;
    if (x.state === "error") out.errors += 1;
    if (x.state === "lost") out.lost += 1;
    if (!needs && x.state !== "error" && x.state !== "lost") out.fine += 1;
  }
  return out;
}
