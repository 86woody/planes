// D-61: fold Claude Code transcript lines (<claude>/projects/<slug>/<sessionId>.jsonl and its
// subagents/agent-<id>.jsonl) into one Telemetry value and into span records for the trace store.
// Pure: no I/O, no timers, no clock reads. Never reads prompt, response, tool input or tool
// output text; names, ids, timestamps and counts only.
import type { Telemetry } from "@mc/contracts";

export interface SubagentInfo {
  /** The agent id from the file name (agent-<id>.jsonl). */
  id: string;
  /** agentType from <id>.meta.json. */
  type: string | null;
  /** The main-thread tool_use id that launched it (meta toolUseId). */
  toolUseId: string | null;
}

export interface ClaudeFold {
  /** One line of the main transcript, or of a subagent transcript when `agent` is given. */
  addLine(line: string, agent?: SubagentInfo): void;
  snapshot(nowMs: number): Telemetry;
  /** Span records (the Copilot OTel span shape the trace store reads) made since the last call. */
  takeSpans(): SpanRecord[];
}

export interface SpanRecord {
  type: "span";
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number | null;
  status: { code: 0 | 1 | 2 };
  attributes: Record<string, string | number>;
}

type Obj = Record<string, unknown>;
type Telem = Telemetry;
type RecentCall = Telem["recentCalls"][number];
type Subagent = Telem["subagents"][number];
type ToolRow = Telem["tools"][number];

const RATE_WINDOW_MS = 60_000;
const RECENT_CALLS_MAX = 120;
const SUBAGENTS_MAX = 20;
const TOOLS_MAX = 50;
const SHORT_MAX = 64;
const STANDARD_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const short = (v: unknown): string | undefined => str(v)?.slice(0, SHORT_MAX);
const count = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const iso = (ms: number): string => new Date(ms).toISOString();

function nearestRank(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/**
 * The prompt window a Claude model has, as an estimate: 1M when the model id says `[1m]` or a
 * prompt larger than 200k was seen (a compaction's preTokens counts), else 200k.
 */
export function claudeContextWindow(model: string | null, largestPrompt: number): number {
  if (model !== null && /\[1m\]/i.test(model)) return LARGE_WINDOW;
  return largestPrompt > STANDARD_WINDOW ? LARGE_WINDOW : STANDARD_WINDOW;
}

interface Call {
  traceId: string | null;
  parent: string | null;
  startMs: number;
  firstMs: number;
  endMs: number;
  model: string | null;
  prompt: number;
  output: number;
  subagent: boolean;
  failed: boolean;
}

interface ToolStart {
  name: string;
  skill: string | null;
  ms: number;
  traceId: string | null;
  parent: string | null;
}

interface ToolStat {
  runs: number;
  failed: number;
  durations: number[];
  lastMs: number;
}

interface Run {
  traceId: string;
  startMs: number;
  lastMs: number;
  closed: boolean;
}

interface Thread {
  /** When the next model call of this thread starts: the prompt or the last tool result. */
  cursorMs: number | null;
}

export function createClaudeFold(): ClaudeFold {
  let newestMs: number | null = null;
  let model: string | null = null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const calls = { total: 0, failed: 0, rateLimited: 0 };
  const ttftSamples: number[] = [];
  const durationSamples: number[] = [];
  let promptTokens: number | null = null;
  let largestPrompt = 0;
  let errorCount = 0;
  let errorLastType: string | null = null;
  const recentCalls: RecentCall[] = [];
  const rateSamples: { atMs: number; tokens: number }[] = [];

  const seenMessages = new Map<string, Call>();
  const toolStarts = new Map<string, ToolStart>();
  const tools = new Map<string, ToolStat>();
  /** traceId of each main-thread tool_use, so a subagent's spans join the run that launched it. */
  const toolTrace = new Map<string, string>();

  let permRequested = 0;
  let permApproved = 0;
  let permDenied = 0;

  const subagents = new Map<string, Subagent & { firstMs: number; lastMs: number }>();
  let compactionCount = 0;

  let run: Run | null = null;
  const main: Thread = { cursorMs: null };
  const threads = new Map<string, Thread>();
  let spans: SpanRecord[] = [];

  const touch = (ms: number): void => {
    newestMs = newestMs === null ? ms : Math.max(newestMs, ms);
  };

  const statFor = (name: string): ToolStat => {
    let s = tools.get(name);
    if (!s) {
      s = { runs: 0, failed: 0, durations: [], lastMs: 0 };
      tools.set(name, s);
    }
    return s;
  };

  const rootId = (traceId: string): string => `run-${traceId}`.slice(0, 64);

  const emitRoot = (r: Run, endMs: number | null, ok: boolean): void => {
    spans.push({
      type: "span",
      traceId: r.traceId,
      spanId: rootId(r.traceId),
      parentSpanId: null,
      name: "invoke_agent claude-code",
      startTime: r.startMs,
      endTime: endMs,
      status: { code: ok ? 1 : 0 },
      attributes: { "github.copilot.agent.type": "claude-code" },
    });
  };

  /** A run that never got its turn_duration (an interrupt) closes at its last activity. */
  const closeRun = (endMs: number | null, ok: boolean): void => {
    if (run === null || run.closed) return;
    run.closed = true;
    emitRoot(run, endMs ?? run.lastMs, ok);
  };

  const startRun = (traceId: string, ms: number): void => {
    if (run !== null && run.traceId === traceId) return;
    closeRun(null, false);
    run = { traceId: traceId.slice(0, 64), startMs: ms, lastMs: ms, closed: false };
  };

  const threadFor = (agent: SubagentInfo | undefined): Thread => {
    if (!agent) return main;
    let t = threads.get(agent.id);
    if (!t) {
      t = { cursorMs: null };
      threads.set(agent.id, t);
    }
    return t;
  };

  /** Where a span of this thread hangs: the run root, or the Agent tool span for a subagent. */
  const placement = (agent: SubagentInfo | undefined): { traceId: string | null; parent: string | null } => {
    if (!agent) return run === null ? { traceId: null, parent: null } : { traceId: run.traceId, parent: rootId(run.traceId) };
    const tid = agent.toolUseId === null ? undefined : toolTrace.get(agent.toolUseId);
    if (tid === undefined || agent.toolUseId === null) return { traceId: null, parent: null };
    return { traceId: tid, parent: `tool-${agent.toolUseId}`.slice(0, 64) };
  };

  const emitCall = (id: string, c: Call): void => {
    if (c.traceId === null) return;
    spans.push({
      type: "span",
      traceId: c.traceId,
      spanId: `call-${id}`.slice(0, 64),
      parentSpanId: c.parent,
      name: `chat ${c.model ?? "unknown"}`,
      startTime: c.startMs,
      endTime: c.endMs,
      status: { code: c.failed ? 2 : 1 },
      attributes: {
        ...(c.model === null ? {} : { "gen_ai.response.model": c.model }),
        "gen_ai.usage.input_tokens": c.prompt,
        "gen_ai.usage.output_tokens": c.output,
        "gen_ai.response.time_to_first_chunk": Math.max(0, c.firstMs - c.startMs) / 1000,
      },
    });
  };

  const subagentEntry = (agent: SubagentInfo, ms: number): Subagent & { firstMs: number; lastMs: number } => {
    let e = subagents.get(agent.id);
    if (!e) {
      e = { name: short(agent.type) ?? "subagent", model: null, modelMatches: null, durationMs: null, failed: false, firstMs: ms, lastMs: ms };
      subagents.set(agent.id, e);
      if (subagents.size > SUBAGENTS_MAX) {
        const oldest = subagents.keys().next().value;
        if (oldest !== undefined) subagents.delete(oldest);
      }
    }
    e.firstMs = Math.min(e.firstMs, ms);
    e.lastMs = Math.max(e.lastMs, ms);
    e.durationMs = e.lastMs - e.firstMs;
    return e;
  };

  const onAssistant = (rec: Obj, ms: number, agent: SubagentInfo | undefined): void => {
    const msg = isObj(rec["message"]) ? rec["message"] : {};
    const id = str(msg["id"]) ?? str(rec["uuid"]);
    if (id === undefined) return;
    const thread = threadFor(agent);
    const callModel = short(msg["model"]) ?? null;
    const failed = rec["isApiErrorMessage"] === true;
    let c = seenMessages.get(id);
    if (!c) {
      const where = placement(agent);
      const startMs = Math.min(thread.cursorMs ?? ms, ms);
      c = {
        ...where, startMs, firstMs: ms, endMs: ms, model: callModel, prompt: 0, output: 0,
        subagent: agent !== undefined, failed,
      };
      seenMessages.set(id, c);
      // Usage is the same on every content-block line of one message: count it once.
      const u = isObj(msg["usage"]) ? msg["usage"] : {};
      const input = count(u["input_tokens"]);
      const cacheRead = count(u["cache_read_input_tokens"]);
      const cacheWrite = count(u["cache_creation_input_tokens"]);
      const output = count(u["output_tokens"]);
      const details = isObj(u["output_tokens_details"]) ? u["output_tokens_details"] : {};
      tokens.input += input;
      tokens.cacheRead += cacheRead;
      tokens.cacheWrite += cacheWrite;
      tokens.output += output;
      tokens.reasoning += count(details["thinking_tokens"]);
      c.prompt = input + cacheRead + cacheWrite;
      c.output = output;
      calls.total += 1;
      if (failed) {
        calls.failed += 1;
        errorCount += 1;
        const type = short(rec["error"]) ?? "api_error";
        errorLastType = type;
        if (/rate|429|overload/i.test(type)) calls.rateLimited += 1;
      } else {
        rateSamples.push({ atMs: ms, tokens: input + cacheWrite + output });
        if (!agent) {
          model = callModel ?? model;
          promptTokens = c.prompt;
          largestPrompt = Math.max(largestPrompt, c.prompt);
        }
      }
      if (agent) {
        const e = subagentEntry(agent, ms);
        e.model = callModel ?? e.model;
        if (failed) e.failed = true;
      }
      recentCalls.push({ at: iso(ms), model: callModel, input: c.prompt, output, failed, subagent: agent !== undefined });
      if (recentCalls.length > RECENT_CALLS_MAX) recentCalls.shift();
    } else {
      c.endMs = Math.max(c.endMs, ms);
    }
    if (!agent && run !== null) run.lastMs = Math.max(run.lastMs, ms);
    thread.cursorMs = ms;

    const content = Array.isArray(msg["content"]) ? msg["content"] : [];
    for (const block of content) {
      if (!isObj(block) || block["type"] !== "tool_use") continue;
      const tid = str(block["id"]);
      if (tid === undefined || toolStarts.has(tid)) continue;
      const name = short(block["name"]) ?? "unknown";
      const input = isObj(block["input"]) ? block["input"] : {};
      const skill = name === "Skill" ? (short(input["skill"]) ?? null) : null;
      const where = placement(agent);
      toolStarts.set(tid, { name, skill, ms, traceId: where.traceId, parent: where.parent });
      if (!agent && where.traceId !== null) toolTrace.set(tid, where.traceId);
    }
    emitCall(id, c);
  };

  const onToolResults = (rec: Obj, ms: number, agent: SubagentInfo | undefined): void => {
    const msg = isObj(rec["message"]) ? rec["message"] : {};
    const content = Array.isArray(msg["content"]) ? msg["content"] : [];
    for (const block of content) {
      if (!isObj(block) || block["type"] !== "tool_result") continue;
      const tid = str(block["tool_use_id"]);
      if (tid === undefined) continue;
      const start = toolStarts.get(tid);
      if (!start) continue;
      toolStarts.delete(tid);
      const failed = block["is_error"] === true;
      const stat = statFor(start.skill ?? start.name);
      stat.runs += 1;
      stat.lastMs = Math.max(stat.lastMs, ms);
      if (failed) stat.failed += 1;
      stat.durations.push(Math.max(0, ms - start.ms));
      if (start.traceId !== null) {
        spans.push({
          type: "span",
          traceId: start.traceId,
          spanId: `tool-${tid}`.slice(0, 64),
          parentSpanId: start.parent,
          name: `execute_tool ${start.name}`,
          startTime: start.ms,
          endTime: Math.max(ms, start.ms),
          status: { code: failed ? 2 : 1 },
          attributes: {
            "gen_ai.tool.name": start.name,
            ...(start.skill === null ? {} : { "gen_ai.skill.name": start.skill }),
          },
        });
      }
    }
    threadFor(agent).cursorMs = ms;
    if (agent) subagentEntry(agent, ms);
    if (!agent && run !== null) run.lastMs = Math.max(run.lastMs, ms);

    const pd = rec["permissionDecision"];
    if (isObj(pd)) {
      const source = str(pd["source"]) ?? "";
      const decision = str(pd["decision"]) ?? "";
      // Only a decision a person made, or a refusal, counts as a permission request.
      if (source.startsWith("user") || decision === "reject") {
        permRequested += 1;
        if (decision === "reject") permDenied += 1;
        else permApproved += 1;
      }
    }
  };

  const onUser = (rec: Obj, ms: number, agent: SubagentInfo | undefined): void => {
    const msg = isObj(rec["message"]) ? rec["message"] : {};
    const content = msg["content"];
    const isToolResult = Array.isArray(content) && content.some((b) => isObj(b) && b["type"] === "tool_result");
    if (isToolResult) {
      onToolResults(rec, ms, agent);
      return;
    }
    if (agent) {
      threadFor(agent).cursorMs = ms;
      subagentEntry(agent, ms);
      return;
    }
    if (rec["isMeta"] === true) return;
    const traceId = str(rec["promptId"]) ?? str(rec["uuid"]);
    if (traceId === undefined) return;
    startRun(traceId, ms);
    main.cursorMs = ms;
  };

  const onSystem = (rec: Obj, ms: number, agent: SubagentInfo | undefined): void => {
    if (agent) return;
    const sub = rec["subtype"];
    if (sub === "turn_duration") {
      if (run !== null && !run.closed) {
        const d = num(rec["durationMs"]);
        run.closed = true;
        emitRoot(run, d === undefined ? ms : run.startMs + d, true);
      }
      return;
    }
    if (sub === "compact_boundary") {
      compactionCount += 1;
      const meta = isObj(rec["compactMetadata"]) ? rec["compactMetadata"] : {};
      largestPrompt = Math.max(largestPrompt, count(meta["preTokens"]));
      const post = num(meta["postTokens"]);
      if (post !== undefined) promptTokens = Math.round(post);
      const d = num(meta["durationMs"]) ?? 0;
      const where = placement(undefined);
      if (where.traceId !== null) {
        spans.push({
          type: "span",
          traceId: where.traceId,
          spanId: `compact-${str(rec["uuid"]) ?? String(ms)}`.slice(0, 64),
          parentSpanId: where.parent,
          name: "chat compaction",
          startTime: ms - d,
          endTime: ms,
          status: { code: 1 },
          attributes: { "github.copilot.request.type": "compaction" },
        });
      }
      return;
    }
    if (sub === "api_error") {
      errorCount += 1;
      errorLastType = "api_error";
      const status = num(isObj(rec["error"]) ? rec["error"]["status"] : undefined);
      if (status === 429 || status === 529) calls.rateLimited += 1;
    }
  };

  const snapshotTools = (): ToolRow[] =>
    [...tools.entries()]
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

  return {
    addLine(line, agent) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(rec) || typeof rec["type"] !== "string") return;
      const ms = typeof rec["timestamp"] === "string" ? Date.parse(rec["timestamp"]) : NaN;
      if (!Number.isFinite(ms)) return;
      touch(ms);
      switch (rec["type"]) {
        case "assistant":
          onAssistant(rec, ms, agent);
          return;
        case "user":
          onUser(rec, ms, agent);
          return;
        case "system":
          onSystem(rec, ms, agent);
          return;
        default:
      }
    },

    takeSpans() {
      const out = spans;
      spans = [];
      return out;
    },

    snapshot(nowMs) {
      const rate = rateSamples.reduce(
        (sum, s) => (s.atMs > nowMs - RATE_WINDOW_MS && s.atMs <= nowMs ? sum + s.tokens : sum),
        0,
      );
      // Call latency: first block (an estimate of time to first token) and last block.
      ttftSamples.length = 0;
      durationSamples.length = 0;
      for (const c of seenMessages.values()) {
        if (c.failed) continue;
        ttftSamples.push(Math.max(0, c.firstMs - c.startMs));
        durationSamples.push(Math.max(0, c.endMs - c.startMs));
      }
      const max = claudeContextWindow(model, largestPrompt);
      const pct = promptTokens === null ? null : Math.round(Math.min(100, (100 * promptTokens) / max) * 10) / 10;
      return {
        updatedAt: iso(newestMs ?? nowMs),
        sources: ["transcript"],
        model,
        tokens: { ...tokens },
        tokenRate: rate,
        context: { estimatePct: pct, promptTokens, maxPromptTokens: promptTokens === null ? null : max },
        credits: { nanoAiu: null, aiCredits: null },
        calls: { ...calls },
        latency: {
          ttftP50Ms: nearestRank(ttftSamples, 50),
          ttftP95Ms: nearestRank(ttftSamples, 95),
          durationP50Ms: nearestRank(durationSamples, 50),
        },
        errors: { count: errorCount, lastType: errorLastType },
        tools: snapshotTools() as Telem["tools"],
        permissions: { requested: permRequested, approved: permApproved, denied: permDenied, pending: 0, waitedMs: 0, pendingSince: null },
        input: { requested: 0, waitedMs: 0, pendingSince: null },
        subagents: [...subagents.values()].map(({ firstMs: _f, lastMs: _l, ...s }) => ({ ...s })) as Telem["subagents"],
        compaction: { count: compactionCount, tokens: null },
        rewinds: 0,
        truncations: 0,
        warnings: 0,
        codeChanges: null,
        task: null,
        recentCalls: recentCalls.map((c) => ({ ...c })) as Telem["recentCalls"],
        unknownEvents: 0,
      };
    },
  };
}
