import type { Session } from "@mc/contracts";

const WINDOW_MS = 120_000; // rate window
const RECENCY_MS = 90_000; // e-folding time of the recency term
const RATE_FULL = 8; // changes per window that count as full activity

/**
 * Activity per session, kept client side (no contract change, DESIGN.md 3): every time a
 * session's lastEvent.at or updatedAt changes, the change is timed. Activity mixes the
 * recency of the last event with the rate of changes in the last two minutes, 0..1.
 */
export class ActivityTracker {
  private readonly seen = new Map<string, { key: string; hits: number[] }>();

  observe(sessions: Session[], now: number): void {
    const ids = new Set<string>();
    for (const s of sessions) {
      ids.add(s.id);
      const key = `${s.lastEvent.at}|${s.updatedAt}`;
      const entry = this.seen.get(s.id);
      if (entry === undefined) {
        const at = Date.parse(s.lastEvent.at);
        const hits = Number.isFinite(at) && now - at < WINDOW_MS && at <= now ? [at] : [];
        this.seen.set(s.id, { key, hits });
      } else if (entry.key !== key) {
        entry.key = key;
        entry.hits.push(now);
      }
    }
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
  }

  level(s: Session, now: number): number {
    const at = Date.parse(s.lastEvent.at);
    const since = Number.isFinite(at) ? Math.max(0, now - at) : Number.POSITIVE_INFINITY;
    const recency = Math.exp(-since / RECENCY_MS);
    const entry = this.seen.get(s.id);
    if (entry !== undefined) {
      while (entry.hits.length > 0 && (entry.hits[0] ?? 0) < now - WINDOW_MS) entry.hits.shift();
    }
    const rate = Math.min(1, (entry?.hits.length ?? 0) / RATE_FULL);
    return Math.max(0, Math.min(1, 0.15 + 0.45 * recency + 0.4 * rate));
  }
}
