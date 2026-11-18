import type { ProcessInfo } from "@mc/contracts";

/** One process table row: the ProcessInfo fields plus the parent pid. */
export type ProcEntry = ProcessInfo & { ppid: number };

/** The per-OS process backend that index.ts dispatches to. */
export interface ProcBackend {
  /** One snapshot of the process table (or a lazy lookup on Linux). */
  lookupTable(): Promise<(pid: number) => ProcEntry | undefined>;
  startTimeOf(pid: number): Promise<string | null>;
  alive(pid: number, startTime: string | null): Promise<boolean>;
  commandLine(pid: number): Promise<string | null>;
  ttyOf(pid: number): Promise<string | null>;
}

export const MAX_ANCESTRY = 16;
const STOP_NAMES = new Set(["system", "launchd", "systemd", "init"]);

/** Lower-cased image name without a trailing ".exe". */
export function normName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Parse /proc/<pid>/stat. comm sits between the first "(" and the last ")",
 * because it may contain spaces and parentheses. Fields after it are counted
 * from 1 over the whole line: ppid is field 4, starttime is field 22.
 */
export function parseLinuxStat(text: string): {
  pid: number;
  ppid: number;
  startTime: string;
  comm: string;
} {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("malformed /proc stat line");
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  // rest[0] is field 3 (state), so field n is rest[n - 3].
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const startTime = rest[19];
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || startTime === undefined) {
    throw new Error("malformed /proc stat line");
  }
  return { pid, ppid, startTime, comm };
}

/**
 * Parse `ps -A -o pid=,ppid=,lstart=,comm=`. lstart is the fixed 24-character
 * field after the ppid column and one space; name is the basename of the rest.
 */
export function parsePsLstart(output: string): Map<number, { ppid: number; startTime: string; name: string }> {
  const out = new Map<number, { ppid: number; startTime: string; name: string }>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s(.{24})\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const startTime = (m[3] ?? "").trim();
    const comm = m[4] ?? "";
    const name = comm.split("/").pop() ?? comm;
    out.set(pid, { ppid, startTime, name });
  }
  return out;
}

/**
 * Walk parents from `start` (the start process is entry 0), nearest first.
 * Stops at pid 0 or 1, at the names system/launchd/systemd/init (not included),
 * at an unknown pid, at a cycle, and after MAX_ANCESTRY entries.
 */
export function walkAncestry(
  start: number,
  lookup: (pid: number) => ProcEntry | undefined,
): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const seen = new Set<number>();
  let pid = start;
  while (out.length < MAX_ANCESTRY) {
    if (pid <= 1 || seen.has(pid)) break;
    seen.add(pid);
    const e = lookup(pid);
    if (!e) break;
    if (STOP_NAMES.has(normName(e.name))) break;
    const info: ProcessInfo = { pid: e.pid, name: e.name };
    if (e.startTime !== undefined) info.startTime = e.startTime;
    out.push(info);
    pid = e.ppid;
  }
  return out;
}
