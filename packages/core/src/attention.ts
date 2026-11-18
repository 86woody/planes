import type {
  Attention,
  AttentionReason,
  FocusResult,
  Instant,
  IngestEnvelope,
  Session,
  SessionId,
  State,
} from "@mc/contracts";
import { classifyHost } from "./classify.js";
import { summarize, truncate } from "./summary.js";

// Contract: docs/contracts/attention.md sections 1-4. Row IDs (SM-nn) are test names.
export interface ReducerOptions {
  doneIsAttention: boolean; // config notifications.on.done (default true)
  capturePromptText: boolean; // config sessions.capturePromptText
  shellNotifyAfterSeconds: number; // config adapters.shell.notifyAfterSeconds (default 60)
}
export type CoreEvent =
  | { kind: "ingest"; envelope: IngestEnvelope; receivedAt: number }
  | { kind: "process_exited"; sessionId: SessionId; at: number }
  | { kind: "lost_timeout"; sessionId: SessionId; at: number }
  | { kind: "ack"; sessionId: SessionId; at: number }
  | { kind: "restore_result"; sessionId: SessionId; result: FocusResult; ackOnRestore: boolean }
  | { kind: "notified"; sessionId: SessionId; at: number };
export interface SessionCursor {
  lastAppliedSentAt: number;
} // daemon-internal

type Prev = { session: Session; cursor: SessionCursor } | undefined;
type Result = { session: Session; cursor: SessionCursor; changed: boolean };

const CLEAR: Attention = { active: false, reason: null, since: null, acknowledged: false, message: null };
const END_REASONS = ["clear", "resume", "logout", "prompt_input_exit", "other", "process_exit", "lost"];
// ingest.md 6.3: Copilot's SessionEnd reasons onto the endReason enum. Copilot has no value for a normal
// finish or an error, so those land on `other` (the enum's catch-all); the raw reason stays in lastEvent.summary.
const COPILOT_END_REASONS: Record<string, string> = {
  complete: "other",
  error: "other",
  abort: "other",
  timeout: "other",
  user_exit: "prompt_input_exit",
};
const CLAUDE_EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "Notification", "Stop", "SubagentStart", "SubagentStop", "PreCompact",
  "PostCompact", "StopFailure", "SessionEnd",
]);
const SUBAGENT_EVENTS = ["SubagentStart", "SubagentStop", "PreCompact", "PostCompact"];
const RESUME_SOURCES = ["compact", "resume", "fork"];
const RESTART_SOURCES = ["clear", "startup"];
const INPUT_NOTICES = ["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"];

const iso = (ms: number): Instant => new Date(ms).toISOString();
const live = (s: Session): boolean => s.state !== "ended" && s.state !== "lost";
const waiting = (s: Session): boolean => s.state === "needs_permission" || s.state === "needs_input";
const isDoneOrError = (s: Session): boolean =>
  s.attention.active && (s.attention.reason === "done" || s.attention.reason === "error");

function projectOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((x) => x !== "");
  return parts[parts.length - 1] ?? "";
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => k in rb && same(ra[k], rb[k]));
}

function asEndReason(v: string | null): Session["endReason"] {
  return v !== null && END_REASONS.includes(v) ? (v as Session["endReason"]) : "other";
}

function newSession(env: IngestEnvelope, at: Instant, alloc: { nextCallsign(): string }): Session {
  const cwd = typeof env.payload.cwd === "string" ? env.payload.cwd : "";
  const project = truncate(projectOf(cwd), 128);
  return {
    id: `${env.adapter}:${env.nativeSessionId}`,
    adapter: env.adapter,
    nativeId: env.nativeSessionId,
    callsign: alloc.nextCallsign(),
    title: truncate(project, 80),
    cwd,
    project,
    branch: null,
    state: "working",
    attention: { ...CLEAR },
    startedAt: at,
    updatedAt: at,
    lastEvent: { name: env.event, at, summary: "" },
    process: { agentPid: null, alive: null },
    host: classifyHost(env.origin),
    restore: { capability: "none", reason: null, lastResult: null },
    stats: { prompts: 0, tools: 0, notifications: 0, events: 0 },
    endReason: null,
  };
}

// Normalized event: the Claude Code row name the table matches on.
interface Norm {
  name: string;
  sub: string | null; // SessionStart source, Notification type, SessionEnd reason
  msg: string | null; // attention message for the row that sets one
}
const none = (name: string): Norm => ({ name, sub: null, msg: null });

function claudeNorm(event: string, p: IngestEnvelope["payload"]): Norm {
  if (!CLAUDE_EVENTS.has(event)) return none("Other");
  switch (event) {
    case "SessionStart":
      return { name: event, sub: p.source ?? "startup", msg: null };
    case "SessionEnd":
      return { name: event, sub: p.reason ?? null, msg: null };
    case "Notification":
      return { name: event, sub: p.notification_type ?? null, msg: p.message ?? null };
    case "PermissionRequest":
      return { name: event, sub: null, msg: `Permission: ${p.tool_name ?? "unknown"}` };
    case "Stop":
      return { name: event, sub: null, msg: p.last_assistant_message || "Turn complete" };
    case "StopFailure":
      return { name: event, sub: null, msg: p.error || "Turn failed" };
    default:
      return none(event);
  }
}

function shellNorm(event: string, p: IngestEnvelope["payload"], o: ReducerOptions): Norm {
  switch (event) {
    case "ShellStart":
      return { name: "SessionStart", sub: "startup", msg: null };
    case "ShellCommandStart":
      return none("UserPromptSubmit"); // no prompt text; counts commands (SM-32)
    case "ShellCommandEnd": {
      const cmd = p.command ?? "";
      const code = p.exit_code ?? 0;
      if ((p.duration_ms ?? 0) < o.shellNotifyAfterSeconds * 1000) return none("ShellIdle");
      return code !== 0
        ? { name: "StopFailure", sub: null, msg: "Turn failed" }
        : { name: "Stop", sub: null, msg: `${cmd} exited ${code}` };
    }
    case "ShellPrompt":
      return none("ShellPrompt");
    case "ShellExit":
      return { name: "SessionEnd", sub: "other", msg: null };
    default:
      return none("Other");
  }
}

function genericNorm(event: string, p: IngestEnvelope["payload"]): Norm {
  switch (event) {
    case "Start":
      return { name: "SessionStart", sub: "startup", msg: null };
    case "Working":
      return none("PostToolUse");
    case "NeedsInput":
      return { name: "Notification", sub: "agent_needs_input", msg: p.message ?? null };
    case "NeedsPermission":
      return { name: "Notification", sub: "permission_prompt", msg: p.message ?? null };
    case "Done":
      return { name: "Stop", sub: null, msg: p.last_assistant_message || "Turn complete" };
    case "Error":
      return { name: "StopFailure", sub: null, msg: p.error || "Turn failed" };
    case "End":
      return { name: "SessionEnd", sub: p.reason ?? null, msg: null };
    default:
      return none("Other");
  }
}

function normalize(env: IngestEnvelope, o: ReducerOptions): Norm {
  switch (env.adapter) {
    case "claude-code":
      return claudeNorm(env.event, env.payload);
    case "copilot-cli": {
      // D-36: Copilot events arrive already mapped onto Claude Code names; only SessionEnd reasons differ.
      const n = claudeNorm(env.event, env.payload);
      if (n.name === "SessionEnd" && n.sub !== null) n.sub = COPILOT_END_REASONS[n.sub] ?? n.sub;
      return n;
    }
    case "codex":
      return env.event === "agent-turn-complete"
        ? { name: "Stop", sub: null, msg: env.payload.last_assistant_message || "Turn complete" }
        : none("Other");
    case "shell":
      return shellNorm(env.event, env.payload, o);
    case "generic":
      return genericNorm(env.event, env.payload);
    default:
      return none("Other");
  }
}

// Attention helpers. Setting the same reason again only refreshes the message.
function setAttention(s: Session, reason: AttentionReason, msg: string | null, at: Instant): Session {
  const message = msg === null ? null : truncate(msg, 200);
  const a = s.attention;
  const attention: Attention =
    a.active && a.reason === reason
      ? { ...a, message }
      : { active: true, reason, since: at, acknowledged: false, message };
  return { ...s, attention };
}
const clearAttn = (s: Session): Session => ({ ...s, attention: { ...CLEAR } });
const withState = (s: Session, state: State): Session => ({ ...s, state });
const clearIfDoneOrError = (s: Session): Session => (isDoneOrError(s) ? clearAttn(s) : s);

interface Ctx {
  n: Norm;
  env: IngestEnvelope;
  at: Instant;
  o: ReducerOptions;
  created: boolean;
}
interface Row {
  id: string;
  match(s: Session, c: Ctx): boolean;
  apply(s: Session, c: Ctx): Session;
}

// Shared by SM-06 and SM-07 (a created session is live, so SM-07 is checked first).
function promptApply(s: Session, c: Ctx): Session {
  const prompt = c.env.payload.prompt;
  const first = s.stats.prompts === 0;
  const title =
    c.o.capturePromptText && first && typeof prompt === "string" ? truncate(prompt, 80) : s.title;
  return {
    ...clearAttn(withState(s, "working")),
    title,
    stats: { ...s.stats, prompts: s.stats.prompts + 1 },
  };
}

const setInput = (s: Session, c: Ctx): Session => setAttention(withState(s, "needs_input"), "input", c.n.msg, c.at);
const setPermission = (s: Session, c: Ctx): Session =>
  setAttention(withState(s, "needs_permission"), "permission", c.n.msg, c.at);

// Table 1 (Claude Code) plus table 3 mappings. First match wins. SM-24 and SM-25 are
// applied as guards in applyIngest before this table, so they have no row here.
const ROWS: Row[] = [
  { id: "SM-01", match: (s, c) => c.created && c.n.name === "SessionStart" && c.n.sub === "startup",
    apply: (s) => clearAttn(withState(s, "starting")) },
  { id: "SM-02", match: (s, c) => c.created && c.n.name === "SessionStart",
    apply: (s) => clearAttn(withState(s, "idle")) },
  { id: "SM-03", match: (s, c) => !live(s) && c.n.name === "SessionStart",
    apply: (s, c) => ({
      ...clearAttn(withState(s, c.n.sub === "startup" ? "starting" : "idle")),
      endReason: null,
      process: { ...s.process, alive: true },
    }) },
  { id: "SM-04", match: (s, c) => live(s) && c.n.name === "SessionStart" && RESUME_SOURCES.includes(c.n.sub ?? ""),
    apply: (s) => s },
  { id: "SM-05", match: (s, c) => live(s) && c.n.name === "SessionStart" && RESTART_SOURCES.includes(c.n.sub ?? ""),
    apply: (s) => clearAttn(withState(s, "starting")) },
  { id: "SM-07", match: (s, c) => c.created && c.n.name === "UserPromptSubmit", apply: promptApply },
  { id: "SM-06", match: (s, c) => live(s) && c.n.name === "UserPromptSubmit", apply: promptApply },
  { id: "SM-08", match: (s, c) => live(s) && !waiting(s) && c.n.name === "PreToolUse",
    apply: (s) => clearIfDoneOrError(withState(s, "working")) },
  { id: "SM-09", match: (s, c) => live(s) && waiting(s) && c.n.name === "PreToolUse", apply: (s) => s },
  { id: "SM-10", match: (s, c) => live(s) && (c.n.name === "PostToolUse" || c.n.name === "PostToolUseFailure"),
    apply: (s) => ({ ...clearAttn(withState(s, "working")), stats: { ...s.stats, tools: s.stats.tools + 1 } }) },
  { id: "SM-11", match: (s, c) => live(s) && c.n.name === "PermissionRequest", apply: setPermission },
  { id: "SM-12", match: (s, c) => live(s) && c.n.name === "Notification" && c.n.sub === "permission_prompt",
    apply: setPermission },
  { id: "SM-13", match: (s, c) => live(s) && c.n.name === "Notification" && c.n.sub === "idle_prompt" &&
      s.attention.active && s.attention.reason === "done",
    apply: (s) => s },
  { id: "SM-14", match: (s, c) => live(s) && c.n.name === "Notification" && c.n.sub === "idle_prompt",
    apply: setInput },
  { id: "SM-15", match: (s, c) => live(s) && c.n.name === "Notification" && INPUT_NOTICES.includes(c.n.sub ?? ""),
    apply: setInput },
  { id: "SM-17", match: (s, c) => live(s) && c.n.name === "Stop",
    apply: (s, c) =>
      c.o.doneIsAttention
        ? setAttention(withState(s, "idle"), "done", c.n.msg, c.at)
        : clearAttn(withState(s, "idle")) },
  { id: "SM-18", match: (s, c) => live(s) && !waiting(s) && SUBAGENT_EVENTS.includes(c.n.name),
    apply: (s) => clearIfDoneOrError(withState(s, "working")) },
  { id: "SM-19", match: (s, c) => live(s) && c.n.name === "StopFailure",
    apply: (s, c) => setAttention(withState(s, "error"), "error", c.n.msg, c.at) },
  { id: "SM-20", match: (_s, c) => c.n.name === "SessionEnd",
    apply: (s, c) => ({
      ...clearAttn(withState(s, "ended")),
      endReason: asEndReason(c.n.sub),
      process: { ...s.process, alive: false }, // D-38: a session that reports its own end has no live agent
    }) },
  { id: "SM-34", match: (s, c) => live(s) && c.n.name === "ShellIdle", apply: (s) => clearAttn(withState(s, "idle")) },
  { id: "SM-35", match: (s, c) => live(s) && c.n.name === "ShellPrompt", apply: (s) => withState(s, "idle") },
  // SM-16: any other live event (unknown names, Notification of other types). No state change.
  { id: "SM-16", match: (s) => live(s), apply: (s) => s },
  // SM-26: ended or lost with an endReason that does not revive. No state change.
  { id: "SM-26", match: (s) => !live(s), apply: (s) => s },
];

// Sets the session-level fields every applied ingest sets (attention.md section 1).
function finish(before: Session, s: Session, env: IngestEnvelope, at: Instant): Session {
  const p = env.payload;
  let next: Session = {
    ...s,
    updatedAt: at,
    lastEvent: { name: env.event, at, summary: summarize(env.adapter, env.event, p) },
    stats: { ...s.stats, events: s.stats.events + 1 },
  };
  if (typeof p.cwd === "string") {
    const project = truncate(projectOf(p.cwd), 128);
    // The title follows the project until a prompt sets it.
    const title =
      s.title === before.title && before.title === before.project ? truncate(project, 80) : s.title;
    next = { ...next, cwd: p.cwd, project, title };
  }
  const agent = env.origin.agent;
  if (agent) {
    next = { ...next, process: { agentPid: agent.pid, alive: live(next) ? true : next.process.alive } };
  }
  return next;
}

function applyIngest(prev: Prev, env: IngestEnvelope, o: ReducerOptions, alloc: { nextCallsign(): string }): Result {
  const n = normalize(env, o);
  const at = iso(env.sentAt);
  // SM-24: a stale ingest only counts. SessionEnd always applies.
  if (prev && env.sentAt < prev.cursor.lastAppliedSentAt && n.name !== "SessionEnd") {
    const s = prev.session;
    return {
      session: { ...s, stats: { ...s.stats, events: s.stats.events + 1 } },
      cursor: prev.cursor,
      changed: true,
    };
  }
  const before: Session = prev ? prev.session : newSession(env, at, alloc);
  let base = before;
  // SM-25: a process_exit or lost session revives on a newer non-SessionStart ingest.
  if (
    prev &&
    !live(prev.session) &&
    (prev.session.endReason === "process_exit" || prev.session.endReason === "lost") &&
    n.name !== "SessionStart"
  ) {
    base = { ...prev.session, state: "working", endReason: null, process: { ...prev.session.process, alive: true } };
  }
  const ctx: Ctx = { n, env, at, o, created: prev === undefined };
  const row = ROWS.find((r) => r.match(base, ctx));
  const applied = row ? row.apply(base, ctx) : base;
  const session = finish(before, applied, env, at);
  return {
    session,
    cursor: { lastAppliedSentAt: Math.max(prev?.cursor.lastAppliedSentAt ?? 0, env.sentAt) },
    changed: prev === undefined || !same(prev.session, session),
  };
}

function applyOther(prev: Prev, ev: Exclude<CoreEvent, { kind: "ingest" }>): Result | undefined {
  if (!prev) return undefined;
  const s = prev.session;
  let next: Session = s;
  switch (ev.kind) {
    case "process_exited": // SM-21
      if (live(s)) next = { ...clearAttn(withState(s, "ended")), endReason: "process_exit", process: { ...s.process, alive: false } };
      break;
    case "lost_timeout": // SM-22
      if (live(s)) next = { ...clearAttn(withState(s, "lost")), endReason: "lost" };
      break;
    case "ack": // SM-23
      if (s.attention.active) next = { ...s, attention: { ...s.attention, acknowledged: true } };
      break;
    case "restore_result": { // SM-27
      const ack = ev.ackOnRestore && ev.result.status !== "failed" && s.attention.active;
      next = {
        ...s,
        restore: { ...s.restore, lastResult: ev.result },
        attention: ack ? { ...s.attention, acknowledged: true } : s.attention,
      };
      break;
    }
    case "notified": // SM-38
      next = { ...s, stats: { ...s.stats, notifications: s.stats.notifications + 1 } };
      break;
  }
  return { session: next, cursor: prev.cursor, changed: !same(s, next) };
}

export function reduce(
  prev: { session: Session; cursor: SessionCursor } | undefined,
  ev: CoreEvent,
  opts: ReducerOptions,
  alloc: { nextCallsign(): string },
): { session: Session; cursor: SessionCursor; changed: boolean } | undefined {
  if (ev.kind === "ingest") return applyIngest(prev, ev.envelope, opts, alloc);
  return applyOther(prev, ev);
}
