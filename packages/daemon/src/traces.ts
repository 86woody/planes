// D-57: Copilot traces per session. Groups the OTel span records that telemetry.ts routes into
// TraceRun values (api.schema.json). Keeps names, ids, timing, tokens, status and event names only.
// Never content. Writes only under <stateDir>/traces/.
import { readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateTracesResponse, type TraceRun, type TraceSpan } from "@mc/contracts";
import type { DaemonDeps } from "./internal.js";

export interface TraceStore {
  /** Takes one Copilot OTel span record for a session; other records are ignored. */
  addSpan(sessionId: string, rec: unknown): void;
  /** The session's runs, oldest first, at most 50. */
  runs(sessionId: string): TraceRun[];
  /** Writes every changed session file now. */
  flush(): Promise<void>;
}

type Deps = Pick<DaemonDeps, "clock" | "log" | "paths" | "sessions">;

const MAX_RUNS = 50;
const MAX_SPANS = 500;
const MAX_EVENTS = 20;
const DEBOUNCE_MS = 2000;
const MAX_TIME_MS = 8.64e15;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Attribute reading, as in core's telemetry fold: OTLP list form or plain object form.
function otlp(v: unknown): unknown {
  if (!isObj(v)) return v;
  if (v["intValue"] !== undefined) return typeof v["intValue"] === "string" ? Number(v["intValue"]) : v["intValue"];
  if (v["doubleValue"] !== undefined) return v["doubleValue"];
  if (v["stringValue"] !== undefined) return v["stringValue"];
  if (v["boolValue"] !== undefined) return v["boolValue"];
  return undefined;
}

function readAttrs(raw: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isObj(item) && typeof item["key"] === "string") out.set(item["key"], otlp(item["value"]));
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) out.set(k, otlp(v));
  }
  return out;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const count = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.trunc(n) : null;
};

/** An epoch-ms time: ISO string, number of ms, or OTel [seconds, nanos]. */
function epochMs(v: unknown): number | null {
  let ms: number | null = null;
  if (typeof v === "number") ms = v;
  else if (typeof v === "string") ms = Date.parse(v);
  else if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    ms = v[0] * 1000 + v[1] / 1e6;
  }
  return ms !== null && Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS ? ms : null;
}

interface RunMeta {
  agent: string | null;
  nanoAiu: number | null;
  turnCount: number | null;
}

interface ParsedSpan {
  traceId: string;
  span: TraceSpan;
  isRoot: boolean;
  meta: RunMeta | null;
}

/** Reads one span record into a TraceSpan, copying only the listed attributes. Null when unusable. */
function parseSpan(rec: unknown): ParsedSpan | null {
  if (!isObj(rec) || rec["type"] !== "span") return null;
  const traceId = str(rec["traceId"], 64);
  const spanId = str(rec["spanId"], 64);
  const startMs = epochMs(rec["startTime"]);
  if (traceId === null || spanId === null || startMs === null) return null;

  const endMs = epochMs(rec["endTime"]);
  const durationMs = endMs !== null && endMs >= startMs ? endMs - startMs : null;

  const attrs = readAttrs(rec["attributes"]);
  const parent = str(rec["parentSpanId"], 64);
  const name = typeof rec["name"] === "string" ? rec["name"] : "";
  const op = name.split(" ")[0] ?? "";

  const code = isObj(rec["status"]) ? rec["status"]["code"] : undefined;
  const status: TraceSpan["status"] =
    code === 2 || code === "ERROR" ? "error" : code === 1 || code === "OK" ? "ok" : "unset";

  const skill = str(attrs.get("gen_ai.skill.name"), 64);
  let kind: TraceSpan["kind"];
  if (op === "invoke_agent") kind = "agent";
  else if (op === "chat") kind = attrs.get("github.copilot.request.type") === "compaction" ? "compaction" : "chat";
  else if (op === "execute_tool") kind = skill !== null ? "skill" : "tool";
  else kind = "other";

  const ttftSec = num(attrs.get("gen_ai.response.time_to_first_chunk"));
  const events: TraceSpan["events"] = [];
  if (Array.isArray(rec["events"])) {
    for (const e of rec["events"]) {
      if (!isObj(e)) continue;
      const en = str(e["name"], 64);
      const at = epochMs(e["time"]);
      if (en !== null && at !== null) events.push({ name: en, at: new Date(at).toISOString() });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const span: TraceSpan = {
    spanId,
    parentSpanId: parent,
    kind,
    name: name.slice(0, 96),
    startedAt: new Date(startMs).toISOString(),
    durationMs,
    status,
    model: str(attrs.get("gen_ai.response.model"), 64) ?? str(attrs.get("gen_ai.request.model"), 64),
    tool: skill ?? str(attrs.get("gen_ai.tool.name"), 64),
    inputTokens: count(attrs.get("gen_ai.usage.input_tokens")),
    outputTokens: count(attrs.get("gen_ai.usage.output_tokens")),
    ttftMs: ttftSec !== null && ttftSec >= 0 ? ttftSec * 1000 : null,
    serverMs: num(attrs.get("github.copilot.server_duration")),
    events: events.slice(-MAX_EVENTS),
  };
  const isRoot = kind === "agent" && parent === null;
  const meta: RunMeta | null = isRoot
    ? {
        agent: str(attrs.get("github.copilot.agent.type"), 64),
        nanoAiu: count(attrs.get("github.copilot.nano_aiu")),
        turnCount: count(attrs.get("github.copilot.turn_count")),
      }
    : null;
  return { traceId, span, isRoot, meta };
}

/** One trace as the store holds it. Spans are keyed by spanId, so a duplicate replaces. */
interface Acc {
  spans: Map<string, TraceSpan>;
  rootId: string | null;
  meta: RunMeta | null;
  dropped: number;
}

function startOf(acc: Acc): number {
  let min = Infinity;
  for (const s of acc.spans.values()) min = Math.min(min, Date.parse(s.startedAt));
  return min;
}

function toRun(traceId: string, acc: Acc): TraceRun {
  const sorted = [...acc.spans.values()].sort((a, b) => {
    const rank = (s: TraceSpan): number => (s.spanId === acc.rootId ? 0 : 1);
    return rank(a) - rank(b) || Date.parse(a.startedAt) - Date.parse(b.startedAt);
  });
  const root = acc.rootId === null ? undefined : acc.spans.get(acc.rootId);
  const complete = root !== undefined;
  return {
    traceId,
    startedAt: new Date(startOf(acc)).toISOString(),
    durationMs: complete ? root.durationMs : null,
    status: complete ? root.status : "unset",
    agent: complete ? (acc.meta?.agent ?? null) : null,
    nanoAiu: complete ? (acc.meta?.nanoAiu ?? null) : null,
    turnCount: complete ? (acc.meta?.turnCount ?? null) : null,
    complete,
    spans: sorted.slice(0, MAX_SPANS),
    droppedSpans: Math.max(0, sorted.length - MAX_SPANS) + acc.dropped,
  };
}

/** Rebuilds an accumulator from a persisted run. */
function fromRun(run: TraceRun): Acc {
  const root = run.spans.find((s) => s.kind === "agent" && s.parentSpanId === null);
  const complete = run.complete && root !== undefined;
  return {
    spans: new Map(run.spans.map((s) => [s.spanId, s])),
    rootId: complete ? root.spanId : null,
    meta: complete ? { agent: run.agent, nanoAiu: run.nanoAiu, turnCount: run.turnCount } : null,
    dropped: run.droppedSpans,
  };
}

function newestRuns(runs: Map<string, Acc>): TraceRun[] {
  return [...runs]
    .map(([id, acc]) => toRun(id, acc))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .slice(-MAX_RUNS);
}

export function createTraceStore(deps: Deps): TraceStore {
  const { log, paths, sessions } = deps;
  const states = new Map<string, Map<string, Acc>>();
  const dirty = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const fileFor = (sessionId: string): string =>
    path.join(paths.stateDir, "traces", `${encodeURIComponent(sessionId)}.json`);

  const loadRuns = (sessionId: string): Map<string, Acc> => {
    const file = fileFor(sessionId);
    const out = new Map<string, Acc>();
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ file, err: String(err) }, "trace file unreadable");
      return out;
    }
    try {
      const body = JSON.parse(raw) as { runs?: unknown };
      const checked = validateTracesResponse({ sessionId, runs: body.runs });
      if (!checked.ok) {
        log.warn({ file, errors: checked.errors.slice(0, 3) }, "trace file invalid");
        return out;
      }
      for (const run of checked.value.runs) out.set(run.traceId, fromRun(run));
    } catch (err) {
      log.warn({ file, err: String(err) }, "trace file unreadable");
    }
    return out;
  };

  const runsFor = (sessionId: string): Map<string, Acc> => {
    let runs = states.get(sessionId);
    if (!runs) {
      runs = loadRuns(sessionId);
      states.set(sessionId, runs);
    }
    return runs;
  };

  const prune = (runs: Map<string, Acc>): void => {
    while (runs.size > MAX_RUNS) {
      let oldest: string | null = null;
      let oldestMs = Infinity;
      for (const [id, acc] of runs) {
        const ms = startOf(acc);
        if (ms < oldestMs) {
          oldestMs = ms;
          oldest = id;
        }
      }
      if (oldest === null) return;
      runs.delete(oldest);
    }
  };

  const writeRuns = async (sessionId: string, runs: Map<string, Acc>): Promise<void> => {
    const file = fileFor(sessionId);
    const body = JSON.stringify({ version: 1, sessionId, runs: newestRuns(runs) });
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  };

  const writeDirty = async (): Promise<void> => {
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const runs = states.get(id);
      if (!runs) continue; // the session was removed meanwhile
      try {
        await writeRuns(id, runs);
      } catch (err) {
        dirty.add(id);
        log.warn({ sessionId: id, err: String(err) }, "trace write failed");
      }
    }
  };

  // Writes run one after another, so a flush never races a debounced write on the same file.
  let chain: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    chain = chain.then(writeDirty);
    return chain;
  };

  const markDirty = (sessionId: string): void => {
    dirty.add(sessionId);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => undefined);
    }, DEBOUNCE_MS);
    timer.unref();
  };

  sessions.onChange((c) => {
    if (c.type !== "remove") return;
    const id = c.id as string;
    states.delete(id);
    dirty.delete(id);
    try {
      rmSync(fileFor(id), { force: true });
    } catch (err) {
      log.warn({ sessionId: id, err: String(err) }, "trace file delete failed");
    }
  });

  return {
    addSpan(sessionId, rec) {
      const parsed = parseSpan(rec);
      if (parsed === null) return;
      const runs = runsFor(sessionId);
      let acc = runs.get(parsed.traceId);
      if (!acc) {
        acc = { spans: new Map(), rootId: null, meta: null, dropped: 0 };
        runs.set(parsed.traceId, acc);
      }
      acc.spans.set(parsed.span.spanId, parsed.span);
      if (parsed.isRoot) {
        acc.rootId = parsed.span.spanId;
        acc.meta = parsed.meta;
      }
      prune(runs);
      markDirty(sessionId);
    },
    runs(sessionId) {
      return newestRuns(runsFor(sessionId));
    },
    flush,
  };
}
