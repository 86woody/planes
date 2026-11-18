// D-56: the daemon reads Copilot's session logs and the OTel files into Session.telemetry.
// Read-only toward COPILOT_HOME; writes and deletes only under <stateDir>/otel/ (old files).
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { createClaudeFold, createCopilotFold, type ClaudeFold, type CopilotFold, type SubagentInfo } from "@mc/core";
import type { Clock, Logger, Paths, SessionService } from "./internal.js";
import type { TraceStore } from "./traces.js";

// Contract: docs/DECISIONS.md D-56 item 1, docs/contracts/internal.md (telemetry.ts row).
const MAX_READ_BYTES = 8 * 1024 * 1024;
const RECENT_ENDED_MS = 60_000;
const OTEL_KEEP_MS = 7 * 24 * 3_600_000;
const NL = 0x0a;

interface Cursor {
  offset: number;
  rest: Buffer;
}

interface SessionState {
  fold: CopilotFold;
  events: Cursor;
  fed: boolean;
}

interface ClaudeState {
  fold: ClaudeFold;
  file: string | null;
  lookedAt: number;
  main: Cursor;
  subs: Map<string, { cursor: Cursor; info: SubagentInfo }>;
  fed: boolean;
}

const newCursor = (): Cursor => ({ offset: 0, rest: Buffer.alloc(0) });
/** A Claude Code session id names a file; nothing that could leave the projects folder. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOKUP_RETRY_MS = 30_000;

interface ReadResult {
  lines: string[];
  reset: boolean;
  size: number;
}

/**
 * Reads bytes after cursor.offset (at most MAX_READ_BYTES) and returns the complete lines.
 * The partial last line stays in cursor.rest. A file that shrank restarts at offset 0.
 * Returns null when the file does not exist.
 */
function readNew(file: string, cursor: Cursor): ReadResult | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    let reset = false;
    if (size < cursor.offset) {
      reset = true;
      cursor.offset = 0;
      cursor.rest = Buffer.alloc(0);
    }
    const len = Math.min(size - cursor.offset, MAX_READ_BYTES);
    const buf = Buffer.alloc(Math.max(0, len));
    const n = len > 0 ? readSync(fd, buf, 0, len, cursor.offset) : 0;
    cursor.offset += n;
    const combined = Buffer.concat([cursor.rest, buf.subarray(0, n)]);
    const lines: string[] = [];
    let start = 0;
    for (let i = combined.indexOf(NL, 0); i !== -1; i = combined.indexOf(NL, start)) {
      let end = i;
      if (end > start && combined[end - 1] === 0x0d) end -= 1;
      if (end > start) lines.push(combined.subarray(start, end).toString("utf8"));
      start = i + 1;
    }
    cursor.rest = Buffer.from(combined.subarray(start));
    return { lines, reset, size };
  } finally {
    closeSync(fd);
  }
}

/** The string value of a conversation id attribute, in object or OTLP list form. */
function conversationId(raw: unknown): string | undefined {
  const value = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v !== null && typeof (v as { stringValue?: unknown }).stringValue === "string") {
      return (v as { stringValue: string }).stringValue;
    }
    return undefined;
  };
  const key = "gen_ai.conversation.id";
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "object" && item !== null && (item as { key?: unknown }).key === key) {
        return value((item as { value?: unknown }).value);
      }
    }
    return undefined;
  }
  if (typeof raw === "object" && raw !== null) return value((raw as Record<string, unknown>)[key]);
  return undefined;
}

export function createTelemetry(
  deps: Pick<{ clock: Clock; log: Logger; sessions: SessionService; paths: Paths }, "clock" | "log" | "sessions" | "paths"> & {
    traces?: Pick<TraceStore, "addSpan">; // D-57 (T117); optional so the D-56 tests need no store
  },
  opts: { copilotHome: string; claudeHome?: string; tickMs?: number },
): { start(): void; stop(): void; tickNow(): Promise<void> } {
  const { clock, log, sessions, paths, traces } = deps;
  const tickMs = opts.tickMs ?? 2000;
  const states = new Map<string, SessionState>();
  const otelCursors = new Map<string, Cursor>();
  const warned = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const warnOnce = (file: string, err: unknown): void => {
    if (warned.has(file)) return;
    warned.add(file);
    log.warn({ file, err: String(err) }, "telemetry read failed");
  };

  const stateFor = (id: string): SessionState => {
    let st = states.get(id);
    if (!st) {
      st = { fold: createCopilotFold(), events: { offset: 0, rest: Buffer.alloc(0) }, fed: false };
      states.set(id, st);
    }
    return st;
  };

  const readEvents = (id: string, nativeId: string): void => {
    const file = path.join(opts.copilotHome, "session-state", nativeId, "events.jsonl");
    try {
      const st = stateFor(id);
      const r = readNew(file, st.events);
      if (!r) return;
      st.fed = true;
      if (r.reset) st.fold = createCopilotFold();
      for (const l of r.lines) st.fold.addEventLine(l);
    } catch (err) {
      warnOnce(file, err);
    }
  };

  const readOtel = (): void => {
    const dir = path.join(paths.stateDir, "otel");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        let cursor = otelCursors.get(file);
        if (!cursor) {
          cursor = { offset: 0, rest: Buffer.alloc(0) };
          otelCursors.set(file, cursor);
        }
        const r = readNew(file, cursor);
        if (!r) {
          otelCursors.delete(file);
          continue;
        }
        for (const l of r.lines) {
          let rec: unknown;
          try {
            rec = JSON.parse(l);
          } catch {
            continue;
          }
          if (typeof rec !== "object" || rec === null) continue;
          const r2 = rec as { type?: unknown; attributes?: unknown };
          if (r2.type !== "span") continue;
          const cid = conversationId(r2.attributes);
          if (cid === undefined) continue;
          const id = `copilot-cli:${cid}`;
          if (!sessions.get(id)) continue;
          const st = stateFor(id);
          st.fed = true;
          st.fold.addOtelRecord(rec);
          traces?.addSpan(id, rec);
        }
        // Delete an OTel file only when it is fully read and has not changed for 7 days.
        if (cursor.offset >= r.size && clock.now() - statSync(file).mtimeMs > OTEL_KEEP_MS) {
          rmSync(file, { force: true });
          otelCursors.delete(file);
        }
      } catch (err) {
        warnOnce(file, err);
      }
    }
  };

  // D-61: Claude Code transcripts. <claudeHome>/projects/<slug>/<nativeId>.jsonl, and the
  // subagent transcripts beside it in <nativeId>/subagents/agent-<id>.jsonl (+ .meta.json).
  const claudeStates = new Map<string, ClaudeState>();

  const findTranscript = (nativeId: string): string | null => {
    const root = path.join(opts.claudeHome ?? "", "projects");
    if (!opts.claudeHome || !SAFE_ID.test(nativeId)) return null;
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const file = path.join(root, d, `${nativeId}.jsonl`);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not in this project folder
      }
    }
    return null;
  };

  const readMeta = (file: string): { type: string | null; toolUseId: string | null } => {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      return {
        type: typeof m["agentType"] === "string" ? m["agentType"] : null,
        toolUseId: typeof m["toolUseId"] === "string" ? m["toolUseId"] : null,
      };
    } catch {
      return { type: null, toolUseId: null };
    }
  };

  const readClaude = (id: string, nativeId: string, now: number): void => {
    let st = claudeStates.get(id);
    if (!st) {
      st = { fold: createClaudeFold(), file: null, lookedAt: 0, main: newCursor(), subs: new Map(), fed: false };
      claudeStates.set(id, st);
    }
    if (st.file === null) {
      if (now - st.lookedAt < LOOKUP_RETRY_MS && st.lookedAt !== 0) return;
      st.lookedAt = now;
      st.file = findTranscript(nativeId);
      if (st.file === null) return;
    }
    const file = st.file;
    try {
      const r = readNew(file, st.main);
      if (r === null) {
        st.file = null;
        return;
      }
      if (r.reset) {
        st.fold = createClaudeFold();
        st.subs.clear();
      }
      if (r.lines.length > 0) st.fed = true;
      for (const l of r.lines) st.fold.addLine(l);
    } catch (err) {
      warnOnce(file, err);
      return;
    }
    // Subagents after the main file, so the Agent tool that launched each one is known.
    const subDir = path.join(path.dirname(file), nativeId, "subagents");
    let names: string[] = [];
    try {
      names = readdirSync(subDir).filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"));
    } catch {
      // no subagents
    }
    for (const n of names) {
      const subFile = path.join(subDir, n);
      let sub = st.subs.get(n);
      if (!sub) {
        const agentId = n.slice("agent-".length, -".jsonl".length);
        const meta = readMeta(path.join(subDir, `agent-${agentId}.meta.json`));
        sub = { cursor: newCursor(), info: { id: agentId, type: meta.type, toolUseId: meta.toolUseId } };
        st.subs.set(n, sub);
      }
      try {
        const r = readNew(subFile, sub.cursor);
        if (r === null) continue;
        if (r.lines.length > 0) st.fed = true;
        for (const l of r.lines) st.fold.addLine(l, sub.info);
      } catch (err) {
        warnOnce(subFile, err);
      }
    }
    for (const rec of st.fold.takeSpans()) traces?.addSpan(id, rec);
  };

  const tickNow = async (): Promise<void> => {
    const now = clock.now();
    const records = sessions.records();
    const known = new Set<string>();

    for (const r of records) {
      const s = r.session;
      known.add(s.id);
      if (s.adapter !== "copilot-cli" && s.adapter !== "claude-code") continue;
      const isLive = s.state !== "ended" && s.state !== "lost";
      if (!isLive && now - Date.parse(s.updatedAt) >= RECENT_ENDED_MS) continue;
      if (typeof s.nativeId !== "string") continue;
      if (s.adapter === "copilot-cli") readEvents(s.id, s.nativeId);
      else readClaude(s.id, s.nativeId, now);
    }

    readOtel();

    for (const id of [...states.keys()]) {
      if (!known.has(id)) states.delete(id);
    }
    for (const id of [...claudeStates.keys()]) {
      if (!known.has(id)) claudeStates.delete(id);
    }

    for (const [id, st] of states) {
      if (!st.fed) continue;
      sessions.setTelemetry(id, st.fold.snapshot(now));
    }
    for (const [id, st] of claudeStates) {
      if (!st.fed) continue;
      sessions.setTelemetry(id, st.fold.snapshot(now));
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tickNow().catch((err: unknown) => warnOnce("tick", err));
      }, tickMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tickNow,
  };
}
