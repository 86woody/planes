import { readFileSync } from "node:fs";
import { exec } from "../exec.js";
import { parseLinuxStat, parsePsLstart, type ProcBackend, type ProcEntry } from "./parse.js";

const IS_MAC = process.platform === "darwin";
// Fixed-width lstart needs the C locale; otherwise day and month names are localized.
const PS_ENV = { ...process.env, LC_ALL: "C" };

function linuxEntry(pid: number): ProcEntry | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  try {
    const s = parseLinuxStat(text);
    return { pid: s.pid, ppid: s.ppid, name: s.comm, startTime: s.startTime };
  } catch {
    return undefined;
  }
}

async function macTable(): Promise<(pid: number) => ProcEntry | undefined> {
  const r = await exec("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { env: PS_ENV });
  const rows = r.code === 0 ? parsePsLstart(r.stdout) : new Map();
  return (pid) => {
    const e = rows.get(pid);
    return e ? { pid, ppid: e.ppid, name: e.name, startTime: e.startTime } : undefined;
  };
}

async function startTimeOf(pid: number): Promise<string | null> {
  if (IS_MAC) {
    const e = (await macTable())(pid);
    return e?.startTime ?? null;
  }
  return linuxEntry(pid)?.startTime ?? null;
}

async function alive(pid: number, startTime: string | null): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (startTime === null) return true;
  return (await startTimeOf(pid)) === startTime;
}

async function commandLine(pid: number): Promise<string | null> {
  if (!IS_MAC) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const line = raw.replace(/\0/g, " ").trim();
      return line === "" ? null : line;
    } catch {
      return null;
    }
  }
  const r = await exec("ps", ["-o", "command=", "-p", String(pid)], { env: PS_ENV });
  const line = r.stdout.trim();
  return r.code === 0 && line !== "" ? line : null;
}

async function ttyOf(pid: number): Promise<string | null> {
  const r = await exec("ps", ["-o", "tty=", "-p", String(pid)], { env: PS_ENV });
  const tty = r.stdout.trim();
  if (r.code !== 0 || tty === "" || tty === "??" || tty === "?") return null;
  return `/dev/${tty}`;
}

export const backend: ProcBackend = {
  async lookupTable() {
    if (IS_MAC) return macTable();
    return linuxEntry;
  },
  startTimeOf,
  alive,
  commandLine,
  ttyOf,
};
