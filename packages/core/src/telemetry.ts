// D-56: fold Copilot events.jsonl lines and OTel file records into one Telemetry value.
// Pure: no I/O, no timers, no clock reads. Time arrives as nowMs. Never reads arguments,
// results, shell output or message content; names and counts only.
import type { Telemetry } from "@mc/contracts";

export interface CopilotFold {
  addEventLine(line: string): void;
  addOtelRecord(rec: unknown): void;
  snapshot(nowMs: number): Telemetry;
}

type Obj = Record<string, unknown>;
type Telem = Telemetry;
type RecentCall = Telem["recentCalls"][number];
type Subagent = Telem["subagents"][number];
type ToolRow = Telem["tools"][number];

/** D-61: Copilot CLI 1.0.112 defines NANO_AIU_PER_AIU = 1e9 (maxNanoAiu = maxAiCredits * 1e9). */
export const NANO_AIU_PER_AI_CREDIT = 1e9;

/** AI Credits from nano-AIU; null stays null. */
export function aiCreditsOf(nanoAiu: number | null): number | null {
  if (nanoAiu === null || !Number.isFinite(nanoAiu) || nanoAiu < 0) return null;
  return nanoAiu / NANO_AIU_PER_AI_CREDIT;
}

const RATE_WINDOW_MS = 60_000;
const RECENT_CALLS_MAX = 120;
const SUBAGENTS_MAX = 20;
const TOOLS_MAX = 50;
const SHORT_MAX = 64;

const IGNORED = new Set([
  "session.start", "session.resume", "session.idle", "session.info", "session.model_change",
  "session.context_changed", "session.usage_info", "user.message", "assistant.message",
  "assistant.turn_start", "assistant.turn_end", "assistant.reasoning", "system.message",
  "instruction.update", "instruction.update_delivery", "hook.start", "hook.end", "skill.invoked",
  "abort", "session.title_changed", "session.plan_changed", "session.todos_changed",
  "session.mcp_servers_loaded", "session.mcp_server_status_changed", "session.skills_loaded",
  "session.tools_updated", "tool.execution_progress", "tool.execution_partial_result",
  "tool.shell_output", "human_response.recorded",
]);

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function short(v: unknown): string | undefined {
  const s = str(v);
  return s === undefined ? undefined : s.slice(0, SHORT_MAX);
}
function count(v: unknown): number {
  const n = num(v);
  return n === undefined ? 0 : Math.max(0, Math.round(n));
}
// A field lives on the usage object when there is one, else on the event data.
function pick(src: Obj, d: Obj, key: string): unknown {
  return src[key] ?? d[key];
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function nearestRank(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}
function estimate(prompt: number | null, max: number | null): number | null {
  if (prompt === null || max === null || max <= 0) return null;
  return Math.round(Math.min(100, (100 * prompt) / max) * 10) / 10;
}
// OTLP attribute values are {intValue: "12"} and similar; plain JSON values pass through.
function otlp(v: unknown): unknown {
  if (!isObj(v)) return v;
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}
function readAttrs(raw: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isObj(item) && typeof item.key === "string") out.set(item.key, otlp(item.value));
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) out.set(k, otlp(v));
  }
  return out;
}

interface ToolStat {
  runs: number;
  failed: number;
  durations: number[];
  lastMs: number;
}

export function createCopilotFold(): CopilotFold {
  let hasEvents = false;
  let hasOtel = false;
  let newestMs: number | null = null;

  let model: string | null = null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const calls = { total: 0, failed: 0, rateLimited: 0 };
  const ttftSamples: number[] = [];
  const durationSamples: number[] = [];
  let promptTokens: number | null = null;
  let maxPromptTokens: number | null = null;
  let eventNanoAiu: number | null = null;
  let otelNanoAiu: number | null = null;
  let errorCount = 0;
  let errorLastType: string | null = null;
  const recentCalls: RecentCall[] = [];
  const rateSamples: { atMs: number; tokens: number }[] = [];

  const toolStarts = new Map<string, { name: string; ts: number }>();
  const tools = new Map<string, ToolStat>();

  let permRequested = 0;
  let permApproved = 0;
  let permDenied = 0;
  let permPending = 0;
  let permWaitedMs = 0;
  const permRequests = new Map<string, number>();

  let inputRequested = 0;
  let inputWaitedMs = 0;
  const inputRequests = new Map<string, number>();

  const subagents: Subagent[] = [];
  let compactionCount = 0;
  let compactionTokens: number | null = null;
  let rewinds = 0;
  let truncations = 0;
  let warnings = 0;
  let unknownEvents = 0;
  let codeChanges: { linesAdded: number; linesRemoved: number } | null = null;
  let task: { success: boolean | null; outcome: string | null } | null = null;

  function touch(ms: number): void {
    newestMs = newestMs === null ? ms : Math.max(newestMs, ms);
  }

  function countError(d: Obj): void {
    errorCount += 1;
    errorLastType = short(d.errorType) ?? null;
  }

  function statFor(name: string): ToolStat {
    let stat = tools.get(name);
    if (!stat) {
      stat = { runs: 0, failed: 0, durations: [], lastMs: 0 };
      tools.set(name, stat);
    }
    return stat;
  }

  function pushCall(call: RecentCall): void {
    recentCalls.push(call);
    if (recentCalls.length > RECENT_CALLS_MAX) recentCalls.shift();
  }

  function recordUsage(src: Obj, d: Obj, ms: number): void {
    const input = count(pick(src, d, "inputTokens"));
    const output = count(pick(src, d, "outputTokens"));
    tokens.input += input;
    tokens.output += output;
    tokens.cacheRead += count(pick(src, d, "cacheReadTokens"));
    tokens.cacheWrite += count(pick(src, d, "cacheWriteTokens"));
    tokens.reasoning += count(pick(src, d, "reasoningTokens"));
    calls.total += 1;
    const callModel = short(pick(src, d, "model")) ?? null;
    model = callModel ?? model;
    const subagent = pick(src, d, "initiator") === "sub-agent";
    pushCall({ at: iso(ms), model: callModel, input, output, failed: false, subagent });
    rateSamples.push({ atMs: ms, tokens: input + output });

    const ttft = num(pick(src, d, "timeToFirstTokenMs"));
    if (ttft !== undefined) ttftSamples.push(ttft);
    const duration = num(pick(src, d, "duration"));
    if (duration !== undefined) durationSamples.push(duration);

    promptTokens = input;
    const max = num(pick(src, d, "maxPromptTokens"));
    if (max !== undefined) maxPromptTokens = Math.round(max);
  }

  function onEvent(type: string, d: Obj, ms: number): void {
    switch (type) {
      case "session.usage_record":
        recordUsage(isObj(d.usage) ? d.usage : d, d, ms);
        return;
      case "assistant.usage":
        recordUsage(d, d, ms);
        return;
      case "session.usage_checkpoint":
      case "session.shutdown": {
        const nano = num(d.totalNanoAiu);
        if (nano !== undefined) eventNanoAiu = Math.round(nano);
        if (type !== "session.shutdown") return;
        const cc = d.codeChanges;
        if (isObj(cc)) codeChanges = { linesAdded: count(cc.linesAdded), linesRemoved: count(cc.linesRemoved) };
        const current = num(d.currentTokens);
        if (current !== undefined) promptTokens = Math.round(current);
        return;
      }
      case "session.error":
        countError(d);
        return;
      case "model.call_failure":
        countError(d);
        calls.failed += 1;
        pushCall({
          at: iso(ms), model: short(d.model) ?? null, input: 0, output: 0, failed: true,
          subagent: d.initiator === "sub-agent",
        });
        return;
      case "rate_limit":
        calls.rateLimited += 1;
        return;
      case "tool.execution_start": {
        const id = str(d.toolCallId);
        if (id !== undefined) toolStarts.set(id, { name: short(d.toolName) ?? "unknown", ts: ms });
        return;
      }
      case "tool.execution_complete": {
        const id = str(d.toolCallId);
        const start = id === undefined ? undefined : toolStarts.get(id);
        if (id !== undefined) toolStarts.delete(id);
        const stat = statFor(start?.name ?? "unknown");
        stat.runs += 1;
        stat.lastMs = Math.max(stat.lastMs, ms);
        if (d.success === false) stat.failed += 1;
        if (start) stat.durations.push(Math.max(0, ms - start.ts));
        return;
      }
      case "permission.requested": {
        permRequested += 1;
        permPending += 1;
        const id = str(d.requestId);
        if (id !== undefined) permRequests.set(id, ms);
        return;
      }
      case "permission.completed": {
        const id = str(d.requestId);
        const requestedAt = id === undefined ? undefined : permRequests.get(id);
        if (id !== undefined && requestedAt !== undefined) {
          permRequests.delete(id);
          permPending = Math.max(0, permPending - 1);
          permWaitedMs += Math.max(0, Math.round(ms - requestedAt));
        }
        const kind = str(isObj(d.result) ? d.result.kind : undefined) ?? "";
        if (kind.startsWith("approved")) permApproved += 1;
        else if (kind.startsWith("denied")) permDenied += 1;
        return;
      }
      case "user_input.requested": {
        inputRequested += 1;
        const id = str(d.requestId);
        if (id !== undefined) inputRequests.set(id, ms);
        return;
      }
      case "user_input.completed": {
        const id = str(d.requestId);
        const requestedAt = id === undefined ? undefined : inputRequests.get(id);
        if (id !== undefined && requestedAt !== undefined) {
          inputRequests.delete(id);
          inputWaitedMs += Math.max(0, Math.round(ms - requestedAt));
        }
        return;
      }
      case "subagent.started":
        subagents.push({
          name: short(d.agentName) ?? "unknown", model: null, modelMatches: null,
          durationMs: null, failed: false,
        });
        if (subagents.length > SUBAGENTS_MAX) subagents.shift();
        return;
      case "subagent.completed":
      case "subagent.failed": {
        const name = short(d.agentName) ?? "unknown";
        const entry = [...subagents].reverse().find((s) => s.name === name);
        if (!entry) return;
        if (type === "subagent.failed") {
          entry.failed = true;
          return;
        }
        entry.model = short(d.model) ?? null;
        entry.durationMs = num(d.durationMs) ?? null;
        entry.modelMatches = typeof d.configuredModelMatchesActual === "boolean"
          ? d.configuredModelMatchesActual : null;
        return;
      }
      case "session.compaction_complete": {
        compactionCount += 1;
        const used = num(d.compactionTokensUsed);
        if (used !== undefined) compactionTokens = Math.round((compactionTokens ?? 0) + used);
        return;
      }
      case "session.snapshot_rewind":
        rewinds += 1;
        return;
      case "session.truncation":
        truncations += 1;
        return;
      case "session.warning":
        warnings += 1;
        return;
      case "session.task_complete":
        task = {
          success: typeof d.success === "boolean" ? d.success : null,
          outcome: short(d.outcome) ?? null,
        };
        return;
      default:
        if (!IGNORED.has(type)) unknownEvents += 1;
    }
  }

  function snapshotTools(): ToolRow[] {
    return [...tools.entries()]
      .sort(([, a], [, b]) => b.lastMs - a.lastMs)
      .slice(0, TOOLS_MAX)
      .sort(([an, a], [bn, b]) => b.runs - a.runs || (an < bn ? -1 : an > bn ? 1 : 0))
      .map(([name, s]) => ({
        name,
        runs: s.runs,
        failed: s.failed,
        p50Ms: nearestRank(s.durations, 50),
        maxMs: s.durations.length === 0 ? null : s.durations.reduce((m, x) => Math.max(m, x), 0),
      }));
  }

  function oldestPending(map: Map<string, number>): string | null {
    let oldest: number | null = null;
    for (const at of map.values()) oldest = oldest === null ? at : Math.min(oldest, at);
    return oldest === null ? null : iso(oldest);
  }

  return {
    addEventLine(line: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(parsed) || typeof parsed.type !== "string") return;
      hasEvents = true;
      const d: Obj = isObj(parsed.data) ? parsed.data : {};
      const parsedMs = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      let ms: number;
      if (Number.isFinite(parsedMs)) {
        ms = parsedMs;
        touch(ms);
      } else {
        ms = newestMs ?? 0;
      }
      onEvent(parsed.type, d, ms);
    },

    addOtelRecord(rec: unknown): void {
      if (!isObj(rec)) return;
      hasOtel = true;
      if (rec.type !== "span") return;
      const attrs = readAttrs(rec.attributes);
      if (attrs.get("github.copilot.request.type") === "compaction") {
        const input = num(attrs.get("gen_ai.usage.input_tokens"));
        const output = num(attrs.get("gen_ai.usage.output_tokens"));
        if (input !== undefined || output !== undefined) {
          compactionTokens = Math.round((compactionTokens ?? 0) + (input ?? 0) + (output ?? 0));
        }
      }
      if (rec.name === "invoke_agent") {
        const nano = num(attrs.get("github.copilot.nano_aiu"));
        if (nano !== undefined) otelNanoAiu = (otelNanoAiu ?? 0) + nano;
      }
    },

    snapshot(nowMs: number): Telemetry {
      const rate = rateSamples.reduce(
        (sum, s) => (s.atMs > nowMs - RATE_WINDOW_MS && s.atMs <= nowMs ? sum + s.tokens : sum),
        0,
      );
      const sources: Telem["sources"] = [];
      if (hasEvents) sources.push("events");
      if (hasOtel) sources.push("otel");
      const nano = eventNanoAiu ?? (otelNanoAiu === null ? null : Math.round(otelNanoAiu));
      return {
        updatedAt: iso(newestMs ?? nowMs),
        sources,
        model,
        tokens: { ...tokens },
        tokenRate: rate,
        context: {
          estimatePct: estimate(promptTokens, maxPromptTokens),
          promptTokens,
          maxPromptTokens,
        },
        credits: { nanoAiu: nano, aiCredits: aiCreditsOf(nano) },
        calls: { ...calls },
        latency: {
          ttftP50Ms: nearestRank(ttftSamples, 50),
          ttftP95Ms: nearestRank(ttftSamples, 95),
          durationP50Ms: nearestRank(durationSamples, 50),
        },
        errors: { count: errorCount, lastType: errorLastType },
        tools: snapshotTools() as Telem["tools"],
        permissions: {
          requested: permRequested,
          approved: permApproved,
          denied: permDenied,
          pending: permPending,
          waitedMs: permWaitedMs,
          pendingSince: oldestPending(permRequests),
        },
        input: {
          requested: inputRequested,
          waitedMs: inputWaitedMs,
          pendingSince: oldestPending(inputRequests),
        },
        subagents: subagents.map((s) => ({ ...s })) as Telem["subagents"],
        compaction: { count: compactionCount, tokens: compactionTokens },
        rewinds,
        truncations,
        warnings,
        codeChanges: codeChanges === null ? null : { ...codeChanges },
        task: task === null ? null : { ...task },
        recentCalls: recentCalls.map((c) => ({ ...c })) as Telem["recentCalls"],
        unknownEvents,
      };
    },
  };
}
