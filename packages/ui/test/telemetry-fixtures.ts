import type { Telemetry, TraceRun, TraceSpan } from "@mc/contracts";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const isPlain = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

// Nested objects merge; arrays and other values in the patch replace.
function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

const ZERO_TELEMETRY: Telemetry = {
  updatedAt: "2026-11-12T09:01:00.000Z",
  sources: ["events"],
  model: "claude-sonnet-5.5",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  tokenRate: 0,
  context: { estimatePct: null, promptTokens: null, maxPromptTokens: null },
  credits: { nanoAiu: null, aiCredits: null },
  calls: { total: 0, failed: 0, rateLimited: 0 },
  latency: { ttftP50Ms: null, ttftP95Ms: null, durationP50Ms: null },
  errors: { count: 0, lastType: null },
  tools: [],
  permissions: { requested: 0, approved: 0, denied: 0, pending: 0, waitedMs: 0, pendingSince: null },
  input: { requested: 0, waitedMs: 0, pendingSince: null },
  subagents: [],
  compaction: { count: 0, tokens: null },
  rewinds: 0,
  truncations: 0,
  warnings: 0,
  codeChanges: null,
  task: null,
  recentCalls: [],
  unknownEvents: 0,
};

/** A complete, schema-valid zero telemetry with the patch merged in. */
export function telemetryOf(patch: DeepPartial<Telemetry> = {}): Telemetry {
  return merge(structuredClone(ZERO_TELEMETRY), patch) as Telemetry;
}

const SPAN_START = "2026-11-12T09:00:00.000Z";

export function spanOf(patch: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  return {
    parentSpanId: null,
    kind: "chat",
    name: "chat claude-sonnet-5.5",
    startedAt: SPAN_START,
    durationMs: 1000,
    status: "ok",
    model: null,
    tool: null,
    inputTokens: null,
    outputTokens: null,
    ttftMs: null,
    serverMs: null,
    events: [],
    ...patch,
  };
}

export function runOf(patch: Partial<TraceRun> & { traceId: string }): TraceRun {
  return {
    startedAt: SPAN_START,
    durationMs: 10000,
    status: "ok",
    agent: "copilot",
    nanoAiu: null,
    turnCount: null,
    complete: true,
    spans: [],
    droppedSpans: 0,
    ...patch,
  };
}
