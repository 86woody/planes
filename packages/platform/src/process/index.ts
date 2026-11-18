import type { ProcessInfo } from "@mc/contracts";
import { walkAncestry, type ProcBackend } from "./parse.js";

let loaded: Promise<ProcBackend> | undefined;

/** Load the OS backend on first use, so koffi is never loaded on macOS or Linux. */
function backend(): Promise<ProcBackend> {
  loaded ??= process.platform === "win32"
    ? import("./windows.js").then((m) => m.backend)
    : import("./posix.js").then((m) => m.backend);
  return loaded;
}

/** [info(fromPid), info(parent), ...], nearest first; at most 16, see parse.ts walkAncestry. */
export async function ancestry(fromPid: number): Promise<ProcessInfo[]> {
  const be = await backend();
  const lookup = await be.lookupTable();
  const chain = walkAncestry(fromPid, lookup);
  const out: ProcessInfo[] = [];
  for (const info of chain) {
    if (info.startTime !== undefined) {
      out.push(info);
      continue;
    }
    const startTime = await be.startTimeOf(info.pid);
    out.push(startTime === null ? info : { ...info, startTime });
  }
  return out;
}

export async function processAlive(pid: number, startTime: string | null): Promise<boolean> {
  return (await backend()).alive(pid, startTime);
}

export async function processStartTime(pid: number): Promise<string | null> {
  return (await backend()).startTimeOf(pid);
}

export async function commandLine(pid: number): Promise<string | null> {
  return (await backend()).commandLine(pid);
}

export async function ttyOf(pid: number): Promise<string | null> {
  return (await backend()).ttyOf(pid);
}
