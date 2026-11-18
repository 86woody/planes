import type { TraceRun, TraceSpan } from "@mc/contracts";
import { durationText } from "./telemetry-format.js";

export interface TraceRow {
  span: TraceSpan;
  depth: number;
  orphan: boolean;
  open: boolean;
  startMs: number;
  endMs: number;
  leftPct: number;
  widthPct: number;
}

export interface TraceLayout {
  t0: number;
  t1: number;
  totalMs: number;
  rows: TraceRow[];
  ticks: { pct: number; label: string }[];
}

interface Timed {
  span: TraceSpan;
  startMs: number;
  endMs: number;
  open: boolean;
}

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byStartThenId = (a: Timed, b: Timed): number => a.startMs - b.startMs || cmpId(a.span.spanId, b.span.spanId);

/**
 * D-58 / DESIGN 3a: lay one run out as a waterfall. Pure; `now` ends open spans.
 * Order: the root, then depth-first by child start; spans whose parent is missing come
 * after the tree as depth-0 orphans; a parent cycle still shows each span once.
 */
export function layoutRun(run: TraceRun, now: number): TraceLayout {
  const byId = new Map<string, Timed>();
  for (const span of run.spans) {
    if (byId.has(span.spanId)) continue;
    const startMs = Date.parse(span.startedAt);
    const open = span.durationMs === null;
    const endMs = open ? Math.max(startMs, now) : startMs + (span.durationMs ?? 0);
    byId.set(span.spanId, { span, startMs, endMs, open });
  }
  const timed = [...byId.values()].sort(byStartThenId);

  const t0 = timed.length > 0 ? (timed[0]?.startMs ?? 0) : Date.parse(run.startedAt);
  let t1 = t0 + 1;
  for (const t of timed) t1 = Math.max(t1, t.endMs);
  const totalMs = t1 - t0;

  const children = new Map<string, Timed[]>();
  for (const t of timed) {
    const p = t.span.parentSpanId;
    if (p === null || p === t.span.spanId || !byId.has(p)) continue;
    const list = children.get(p) ?? [];
    list.push(t);
    children.set(p, list);
  }
  for (const list of children.values()) list.sort(byStartThenId);

  const root = timed.find((t) => {
    const p = t.span.parentSpanId;
    return t.span.kind === "agent" && (p === null || !byId.has(p));
  });

  const rows: TraceRow[] = [];
  const seen = new Set<string>();
  const toRow = (t: Timed, depth: number, orphan: boolean): TraceRow => ({
    span: t.span,
    depth,
    orphan,
    open: t.open,
    startMs: t.startMs,
    endMs: t.endMs,
    leftPct: (100 * (t.startMs - t0)) / totalMs,
    widthPct: (100 * (t.endMs - t.startMs)) / totalMs,
  });
  const emit = (t: Timed, depth: number, orphan: boolean): void => {
    seen.add(t.span.spanId);
    rows.push(toRow(t, depth, orphan));
    for (const c of children.get(t.span.spanId) ?? []) {
      if (!seen.has(c.span.spanId)) emit(c, depth + 1, false);
    }
  };

  if (root !== undefined) emit(root, 0, false);
  // Spans whose parent is missing (or absent), in start order.
  for (const t of timed) {
    const p = t.span.parentSpanId;
    if (!seen.has(t.span.spanId) && (p === null || !byId.has(p))) emit(t, 0, true);
  }
  // Whatever is left sits in a parent cycle; each is shown once.
  for (const t of timed) {
    if (!seen.has(t.span.spanId)) emit(t, 0, true);
  }

  const ticks = [0, 25, 50, 75, 100].map((pct) => ({ pct, label: durationText((totalMs * pct) / 100) }));
  return { t0, t1, totalMs, rows, ticks };
}
