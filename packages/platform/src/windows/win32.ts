// Win32 bindings for discovery (windows.md 2). koffi is loaded on first use, so
// importing this module on macOS or Linux costs nothing and never loads the DLLs.
import { win32 as pathWin32 } from "node:path";
import type { IKoffiRegisteredCallback } from "koffi";

/** One top-level window as seen by discovery. HWND values are "0x" + 16 uppercase hex. */
export interface WindowInfo {
  hwnd: string;
  pid: number;
  /** Image basename of the owning process, e.g. "WindowsTerminal.exe"; "" if it cannot be opened. */
  exe: string;
  className: string;
  title: string;
  visible: boolean;
  /** GW_OWNER as hex, null when the window is unowned. */
  owner: string | null;
  /** GA_ROOTOWNER as hex, null when it is the window itself or 0. */
  rootOwner: string | null;
  /** Owning process runs elevated. Needed by chooseWindow (windows.md 1); not in windows.md 2's list. */
  elevated: boolean;
}

/** Per-pass cache of process facts, keyed by pid. */
export type ProcessCache = Map<number, { exe: string; elevated: boolean }>;

export interface Win32Api {
  IsWindow(h: number): boolean;
  IsWindowVisible(h: number): boolean;
  IsIconic(h: number): boolean;
  IsZoomed(h: number): boolean;
  GetForegroundWindow(): number;
  GetWindow(h: number, cmd: number): number;
  GetAncestor(h: number, flags: number): number;
  GetWindowThreadProcessId(h: number, pidOut: number[]): number;
  GetClassNameW(h: number, buf: Buffer, max: number): number;
  GetWindowTextW(h: number, buf: Buffer, max: number): number;
  EnumWindows(cb: unknown, lparam: number): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): number;
  QueryFullProcessImageNameW(h: number, flags: number, buf: Buffer, size: number[]): boolean;
  CloseHandle(h: number): boolean;
  OpenProcessToken(h: number, access: number, out: number[]): boolean;
  GetTokenInformation(tok: number, cls: number, buf: Buffer, len: number, ret: number[]): boolean;
  /** Registers a JS function as the EnumWindows callback; the caller unregisters it. */
  registerEnumProc(fn: (hwnd: number, lparam: number) => boolean): IKoffiRegisteredCallback;
  unregister(ptr: IKoffiRegisteredCallback): void;
}

export const GW_OWNER = 4;
export const GA_ROOTOWNER = 3;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION_CLASS = 20;

let loaded: Promise<Win32Api> | undefined;

/** Load user32, kernel32 and advapi32 once. Rejects on a non-Windows host. */
export function loadWin32(): Promise<Win32Api> {
  loaded ??= import("koffi").then(({ default: koffi }) => {
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const advapi32 = koffi.load("advapi32.dll");
    const EnumWindowsProc = koffi.proto("bool EnumWindowsProc(uintptr_t hwnd, intptr_t lparam)");

    const api: Win32Api = {
      IsWindow: user32.func("bool IsWindow(uintptr_t h)"),
      IsWindowVisible: user32.func("bool IsWindowVisible(uintptr_t h)"),
      IsIconic: user32.func("bool IsIconic(uintptr_t h)"),
      IsZoomed: user32.func("bool IsZoomed(uintptr_t h)"),
      GetForegroundWindow: user32.func("uintptr_t GetForegroundWindow()"),
      GetWindow: user32.func("uintptr_t GetWindow(uintptr_t h, uint32_t cmd)"),
      GetAncestor: user32.func("uintptr_t GetAncestor(uintptr_t h, uint32_t flags)"),
      GetWindowThreadProcessId: user32.func("uint32_t GetWindowThreadProcessId(uintptr_t h, _Out_ uint32_t *pid)"),
      GetClassNameW: user32.func("int GetClassNameW(uintptr_t h, char16_t *buf, int max)"),
      GetWindowTextW: user32.func("int GetWindowTextW(uintptr_t h, char16_t *buf, int max)"),
      EnumWindows: user32.func("bool EnumWindows(EnumWindowsProc *cb, intptr_t lparam)"),
      OpenProcess: kernel32.func("uintptr_t OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      QueryFullProcessImageNameW: kernel32.func(
        "bool QueryFullProcessImageNameW(uintptr_t h, uint32_t flags, char16_t *buf, _Inout_ uint32_t *size)",
      ),
      CloseHandle: kernel32.func("bool CloseHandle(uintptr_t h)"),
      OpenProcessToken: advapi32.func("bool OpenProcessToken(uintptr_t proc, uint32_t access, _Out_ uintptr_t *tok)"),
      GetTokenInformation: advapi32.func(
        "bool GetTokenInformation(uintptr_t tok, int cls, void *buf, uint32_t len, _Out_ uint32_t *ret)",
      ),
      registerEnumProc: (fn) => koffi.register(fn, koffi.pointer(EnumWindowsProc)),
      unregister: (ptr) => koffi.unregister(ptr),
    };
    return api;
  });
  return loaded;
}

/** 0x + 16 uppercase hex digits, the form used in ingest origins and NativeWindow.handle. */
export function hwndToHex(h: number | bigint): string {
  return "0x" + BigInt.asUintN(64, BigInt(h)).toString(16).toUpperCase().padStart(16, "0");
}

/** Normalises a hook-supplied HWND: upper-case hex digits, "0x" prefix kept as "0x" (not "0X"). */
export function normHex(s: string): string {
  return "0x" + s.slice(2).toUpperCase();
}

/** Inverse of hwndToHex. Throws on anything that is not 0x followed by 1-16 hex digits. */
export function hexToHwnd(s: string): number {
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(s)) throw new Error(`not an HWND: ${s}`);
  return Number(BigInt(s));
}

function readWide(read: (buf: Buffer, max: number) => number, max: number): string {
  const buf = Buffer.alloc(max * 2);
  const n = read(buf, max);
  return buf.toString("utf16le", 0, Math.max(0, Math.min(n, max)) * 2);
}

async function processFacts(
  api: Win32Api,
  pid: number,
  cache: ProcessCache,
): Promise<{ exe: string; elevated: boolean }> {
  const hit = cache.get(pid);
  if (hit) return hit;
  let exe = "";
  let elevated = false;
  const ph = pid > 0 ? api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) : 0;
  if (ph) {
    try {
      const size = [1024];
      const buf = Buffer.alloc(1024 * 2);
      if (api.QueryFullProcessImageNameW(ph, 0, buf, size)) {
        exe = pathWin32.basename(buf.toString("utf16le", 0, (size[0] ?? 0) * 2));
      }
      const tok = [0];
      if (api.OpenProcessToken(ph, TOKEN_QUERY, tok) && tok[0]) {
        const out = Buffer.alloc(4);
        const ret = [0];
        if (api.GetTokenInformation(tok[0] ?? 0, TOKEN_ELEVATION_CLASS, out, 4, ret)) {
          elevated = out.readUInt32LE(0) !== 0;
        }
        api.CloseHandle(tok[0] ?? 0);
      }
    } finally {
      api.CloseHandle(ph);
    }
  }
  const facts = { exe, elevated };
  cache.set(pid, facts);
  return facts;
}

/** Facts about one window, or undefined when the handle is not a window. Never changes window state. */
export async function windowInfo(h: number, cache: ProcessCache = new Map()): Promise<WindowInfo | undefined> {
  const api = await loadWin32();
  if (!api.IsWindow(h)) return undefined;
  const pidOut = [0];
  api.GetWindowThreadProcessId(h, pidOut);
  const pid = pidOut[0] ?? 0;
  const facts = await processFacts(api, pid, cache);
  const className = readWide((buf, max) => api.GetClassNameW(h, buf, max), 256);
  const title = readWide((buf, max) => api.GetWindowTextW(h, buf, max), 1024);
  const owner = api.GetWindow(h, GW_OWNER);
  const root = api.GetAncestor(h, GA_ROOTOWNER);
  return {
    hwnd: hwndToHex(h),
    pid,
    exe: facts.exe,
    className,
    title,
    visible: api.IsWindowVisible(h),
    owner: owner ? hwndToHex(owner) : null,
    rootOwner: root && root !== h ? hwndToHex(root) : null,
    elevated: facts.elevated,
  };
}

/** Every visible top-level window, one EnumWindows pass. */
export async function enumerateWindows(cache: ProcessCache = new Map()): Promise<WindowInfo[]> {
  const api = await loadWin32();
  const hwnds: number[] = [];
  const cb = api.registerEnumProc((h) => {
    hwnds.push(h);
    return true;
  });
  try {
    api.EnumWindows(cb, 0);
  } finally {
    api.unregister(cb);
  }
  const out: WindowInfo[] = [];
  for (const h of hwnds) {
    if (!api.IsWindowVisible(h)) continue;
    const info = await windowInfo(h, cache);
    if (info) out.push(info);
  }
  return out;
}

/** The foreground HWND as a number, or 0 when there is none. */
export async function foregroundHwnd(): Promise<number> {
  return (await loadWin32()).GetForegroundWindow();
}
