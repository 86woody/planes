import type { Io } from "../main.js";
import { resolveCliPaths } from "../lib/paths.js";
import { api, findRunning, readToken } from "../lib/daemon.js";

interface SessionLike {
  callsign?: unknown;
  state?: unknown;
  project?: unknown;
  host?: { kind?: unknown } | null;
  updatedAt?: unknown;
  attention?: { active?: unknown; reason?: unknown } | null;
}

// Plain state words, the same as the board (DESIGN.md 4, D-48).
const STATE_WORD: Record<string, string> = {
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  needs_permission: "Needs permission",
  needs_input: "Needs input",
  error: "Error",
  ended: "Ended",
  lost: "Lost",
};

export function stateWord(s: SessionLike): string {
  const state = typeof s.state === "string" ? s.state : "?";
  if (state === "idle" && s.attention?.active === true && s.attention.reason === "done") return "Done";
  return STATE_WORD[state] ?? state;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function hostBadge(kind: unknown): string {
  const k = typeof kind === "string" ? kind : "";
  if (k.includes("vscode")) return "VS CODE";
  return k.replace(/[-_]/g, " ").toUpperCase() || "?";
}

/** One status line: `MC-07  Needs input       schmux        VS CODE     2m`. */
export function sessionLine(s: SessionLike, now: number): string {
  const updated = toMs(s.updatedAt);
  const when = updated === null ? "?" : age(now - updated);
  return [
    String(s.callsign ?? "MC-??"),
    stateWord(s).padEnd(16),
    String(s.project ?? "").padEnd(12),
    hostBadge(s.host?.kind).padEnd(10),
    when,
  ].join("  ");
}

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length > 0) {
    io.err("usage: mc status");
    return 2;
  }
  const paths = resolveCliPaths(io.env);
  const running = await findRunning(paths);
  if (!running) {
    io.err("daemon not running");
    return 1;
  }
  const token = readToken(paths);
  const res = await api(running.port, "GET", "/api/state", { token });
  if (res.status !== 200) {
    io.err(`status failed: HTTP ${res.status}`);
    return 1;
  }
  const state = res.json as { sessions: SessionLike[] };
  io.out(`daemon pid=${running.pid} port=${running.port} sessions=${state.sessions.length}`);
  const now = Date.now();
  for (const s of state.sessions) io.out(sessionLine(s, now));
  return 0;
}
