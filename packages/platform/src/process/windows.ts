import koffi from "koffi";
import { exec } from "../exec.js";
import type { ProcBackend, ProcEntry } from "./parse.js";

// kernel32 functions declared locally (win32.ts belongs to T040).
const k32 = koffi.load("kernel32.dll");

const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32_t",
  cntUsage: "uint32_t",
  th32ProcessID: "uint32_t",
  th32DefaultHeapID: "uintptr_t",
  th32ModuleID: "uint32_t",
  cntThreads: "uint32_t",
  th32ParentProcessID: "uint32_t",
  pcPriClassBase: "int32_t",
  dwFlags: "uint32_t",
  szExeFile: koffi.array("uint16_t", 260),
});
// Registered by name for the GetProcessTimes prototype below.
koffi.struct("FILETIME", {
  dwLowDateTime: "uint32_t",
  dwHighDateTime: "uint32_t",
});

const CreateToolhelp32Snapshot = k32.func(
  "intptr_t CreateToolhelp32Snapshot(uint32_t dwFlags, uint32_t th32ProcessID)",
);
const Process32FirstW = k32.func("bool Process32FirstW(intptr_t hSnapshot, _Inout_ PROCESSENTRY32W *lppe)");
const Process32NextW = k32.func("bool Process32NextW(intptr_t hSnapshot, _Inout_ PROCESSENTRY32W *lppe)");
const OpenProcess = k32.func("intptr_t OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)");
const GetProcessTimes = k32.func(
  "bool GetProcessTimes(intptr_t hProcess, _Out_ FILETIME *lpCreationTime, _Out_ FILETIME *lpExitTime, _Out_ FILETIME *lpKernelTime, _Out_ FILETIME *lpUserTime)",
);
const GetExitCodeProcess = k32.func("bool GetExitCodeProcess(intptr_t hProcess, _Out_ uint32_t *lpExitCode)");
const CloseHandle = k32.func("bool CloseHandle(intptr_t hObject)");
const GetLastError = k32.func("uint32_t GetLastError()");

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
const ERROR_ACCESS_DENIED = 5;

function invalid(h: number): boolean {
  return h === 0 || h === -1;
}

function decodeName(units: number[]): string {
  let s = "";
  for (const u of units) {
    if (u === 0) break;
    s += String.fromCharCode(u);
  }
  return s;
}

function emptyEntry(): Record<string, unknown> {
  return {
    dwSize: koffi.sizeof(PROCESSENTRY32W),
    cntUsage: 0,
    th32ProcessID: 0,
    th32DefaultHeapID: 0,
    th32ModuleID: 0,
    cntThreads: 0,
    th32ParentProcessID: 0,
    pcPriClassBase: 0,
    dwFlags: 0,
    szExeFile: new Array<number>(260).fill(0),
  };
}

function snapshotTable(): Map<number, ProcEntry> {
  const rows = new Map<number, ProcEntry>();
  const h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as number;
  if (invalid(h)) return rows;
  try {
    const pe = emptyEntry();
    let ok = Process32FirstW(h, pe) as boolean;
    while (ok) {
      const pid = pe.th32ProcessID as number;
      rows.set(pid, {
        pid,
        ppid: pe.th32ParentProcessID as number,
        name: decodeName(pe.szExeFile as number[]),
      });
      ok = Process32NextW(h, pe) as boolean;
    }
  } finally {
    CloseHandle(h);
  }
  return rows;
}

/** Creation FILETIME as the decimal string of its 64-bit value. */
function creationTimeOf(pid: number): { handle: number; creation: string | null } | null {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number;
  if (invalid(h)) return null;
  const c = { dwLowDateTime: 0, dwHighDateTime: 0 };
  const e = { dwLowDateTime: 0, dwHighDateTime: 0 };
  const k = { dwLowDateTime: 0, dwHighDateTime: 0 };
  const u = { dwLowDateTime: 0, dwHighDateTime: 0 };
  const ok = GetProcessTimes(h, c, e, k, u) as boolean;
  const creation = ok
    ? ((BigInt(c.dwHighDateTime) << 32n) | BigInt(c.dwLowDateTime)).toString()
    : null;
  return { handle: h, creation };
}

async function startTimeOf(pid: number): Promise<string | null> {
  const r = creationTimeOf(pid);
  if (!r) return null;
  CloseHandle(r.handle);
  return r.creation;
}

async function alive(pid: number, startTime: string | null): Promise<boolean> {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number;
  if (invalid(h)) {
    // Access denied (system processes): alive, start time unknown.
    return (GetLastError() as number) === ERROR_ACCESS_DENIED;
  }
  try {
    const code: number[] = [0];
    const ok = GetExitCodeProcess(h, code) as boolean;
    if (!ok || code[0] !== STILL_ACTIVE) return false;
    if (startTime === null) return true;
    const c = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const e = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const k = { dwLowDateTime: 0, dwHighDateTime: 0 };
    const u = { dwLowDateTime: 0, dwHighDateTime: 0 };
    if (!(GetProcessTimes(h, c, e, k, u) as boolean)) return false;
    return ((BigInt(c.dwHighDateTime) << 32n) | BigInt(c.dwLowDateTime)).toString() === startTime;
  } finally {
    CloseHandle(h);
  }
}

async function commandLine(pid: number): Promise<string | null> {
  // Slow path (0.5-1.5 s): only mc doctor and future adapters use it, never the hook.
  const safePid = Math.trunc(pid);
  const r = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${safePid}').CommandLine`,
    ],
    { timeoutMs: 5000 },
  );
  const line = r.stdout.trim();
  return r.code === 0 && line !== "" ? line : null;
}

export const backend: ProcBackend = {
  async lookupTable() {
    const rows = snapshotTable();
    return (pid) => rows.get(pid);
  },
  startTimeOf,
  alive,
  commandLine,
  async ttyOf() {
    return null;
  },
};
