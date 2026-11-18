import path from "node:path";
import koffi from "koffi";
import type { FocusResult } from "@mc/contracts";
import type { Exec } from "../exec.js";
import { layout } from "../layout.js";
import type { FocusOptions, PlatformEnv, ResolvedTarget } from "../types.js";
import type { Discover } from "./discover.js";

// windows.md 3: window show states and input constants.
export const SW_SHOW = 5;
export const SW_MAXIMIZE = 3;
export const SW_RESTORE = 9;
export const SW_MINIMIZE = 6;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x2;
const INPUT_KEYBOARD = 1;
const FLASHW_ALL = 0x3;
const FLASHW_TIMERNOFG = 0xc;
const ASFW_ANY = 0xffffffff;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x8;
const TOKEN_ELEVATION_CLASS = 20;
const POLL_MS = 25;
const VERIFY_MS = 300;
const HELPER_TIMEOUT_MS = 3000;

export type Step =
  | { kind: "abort"; code: "not_found" | "permission_denied"; detail: string }
  | { kind: "show"; cmd: number }
  | { kind: "alt-key" }
  | { kind: "foreground" }
  | { kind: "attach" }
  | { kind: "verify" }
  | { kind: "flash" };

export interface FocusState {
  isWindow: boolean;
  isIconic: boolean;
  /** Target is elevated and the daemon is not (UIPI). */
  elevated: boolean;
}

/** Pure: the ordered windows.md 3 steps. `verify` stops the run when the window is in front. */
export function planFocus(
  state: FocusState,
  opts: Pick<FocusOptions, "maximize" | "foregroundStrategy">,
): Step[] {
  if (!state.isWindow) return [{ kind: "abort", code: "not_found", detail: "window does not exist" }];
  if (state.elevated) {
    return [{ kind: "abort", code: "permission_denied", detail: "target window is elevated" }];
  }
  let cmd: number;
  if (opts.maximize === "always") cmd = SW_MAXIMIZE;
  else if (opts.maximize === "if-minimized") cmd = state.isIconic ? SW_MAXIMIZE : SW_SHOW;
  else cmd = state.isIconic ? SW_RESTORE : SW_SHOW;

  const steps: Step[] = [{ kind: "show", cmd }];
  if (opts.foregroundStrategy === "alt-key") steps.push({ kind: "alt-key" });
  steps.push(
    { kind: "foreground" },
    { kind: "verify" },
    { kind: "attach" },
    { kind: "verify" },
    { kind: "flash" },
  );
  return steps;
}

export interface WtTab {
  index: number;
  name: string;
  selected?: boolean;
}

// windows.md 4.2: Claude Code title glyphs (idle and spinner frames) or the word "claude".
const CLAUDE_GLYPH = /^[✳✢✶✻✽·*]/;
const CLAUDE_WORD = /claude/i;
// D-54: Copilot CLI titles its tab "<topic> - GitHub Copilot"; Codex is matched by name too.
const AGENT_WORD = /copilot|codex/i;

/** Pure: the tab to select, or null when no single tab can be chosen. */
export function chooseTab(tabs: readonly WtTab[]): number | null {
  const [only] = tabs;
  if (tabs.length === 1 && only) return only.index;
  const hits = tabs.filter((t) => CLAUDE_GLYPH.test(t.name) || CLAUDE_WORD.test(t.name) || AGENT_WORD.test(t.name));
  const [hit] = hits;
  return hits.length === 1 && hit ? hit.index : null;
}

export interface FocusOutcome {
  foreground: boolean;
  tab: "none" | "ok" | "failed";
}

/** Pure: the FocusResult for a finished focus attempt (windows.md 3 step 9, PA-03). */
export function focusResultFor(o: FocusOutcome, at: string): FocusResult {
  if (!o.foreground) {
    return { status: "partial", code: "flashed", detail: "foreground lock refused; taskbar flashed", at };
  }
  if (o.tab === "failed") {
    return {
      status: "partial",
      code: "focused_window_only",
      detail: "window focused; Windows Terminal tab not selected",
      at,
    };
  }
  return { status: "ok", code: "focused", detail: "window focused", at };
}

/** "0x" + 16 hex digits, as NativeWindow.handle. */
export function parseHandle(handle: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(handle)) throw new Error(`bad window handle: ${handle}`);
  return Number(BigInt(handle));
}

export function formatHandle(hwnd: number): string {
  return "0x" + BigInt.asUintN(64, BigInt(hwnd)).toString(16).padStart(16, "0");
}

// ---- Win32 bindings (declared here, not in win32.ts: T040 owns that file) ----

export interface Win32Focus {
  IsWindow(h: number): boolean;
  IsIconic(h: number): boolean;
  IsZoomed(h: number): boolean;
  GetForegroundWindow(): number;
  ShowWindow(h: number, cmd: number): boolean;
  SetForegroundWindow(h: number): boolean;
  BringWindowToTop(h: number): boolean;
  SendInput(count: number, input: unknown, size: number): number;
  GetCurrentThreadId(): number;
  AttachThreadInput(from: number, to: number, attach: boolean): boolean;
  /** Returns the thread id; `pid[0]` receives the process id. */
  GetWindowThreadProcessId(h: number, pid: number[]): number;
  FlashWindowEx(info: unknown): boolean;
  AllowSetForegroundWindow(pid: number): boolean;
  OpenProcess(access: number, inherit: boolean, pid: number): number;
  CloseHandle(h: number): boolean;
  OpenProcessToken(h: number, access: number, out: number[]): boolean;
  GetTokenInformation(h: number, cls: number, buf: number[], len: number, retLen: number[]): boolean;
  /** Input and flash sizes for the x64 struct layouts. */
  inputSize: number;
  flashInfoSize: number;
  makeAltKeyUpInput(): unknown;
  makeFlashInfo(hwnd: number): unknown;
}

let bound: Win32Focus | null = null;

export function loadWin32Focus(): Win32Focus {
  if (bound) return bound;
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");

  const KEYBDINPUT = koffi.struct({
    wVk: "uint16",
    wScan: "uint16",
    dwFlags: "uint32",
    time: "uint32",
    dwExtraInfo: "uintptr_t",
  });
  // INPUT's union is MOUSEINPUT-sized (32 bytes); the pad keeps sizeof(INPUT) == 40 on x64.
  const INPUT = koffi.struct({
    type: "uint32",
    ki: KEYBDINPUT,
    tail: koffi.array("uint8", 8),
  });
  const FLASHWINFO = koffi.struct({
    cbSize: "uint32",
    hwnd: "uintptr_t",
    dwFlags: "uint32",
    uCount: "uint32",
    dwTimeout: "uint32",
  });
  const u32Out = koffi.out(koffi.pointer("uint32"));
  const hOut = koffi.out(koffi.pointer("uintptr_t"));

  const num = (v: unknown): number => Number(v);

  bound = {
    IsWindow: user32.func("IsWindow", "bool", ["uintptr_t"]),
    IsIconic: user32.func("IsIconic", "bool", ["uintptr_t"]),
    IsZoomed: user32.func("IsZoomed", "bool", ["uintptr_t"]),
    GetForegroundWindow: user32.func("GetForegroundWindow", "uintptr_t", []),
    ShowWindow: user32.func("ShowWindow", "bool", ["uintptr_t", "int"]),
    SetForegroundWindow: user32.func("SetForegroundWindow", "bool", ["uintptr_t"]),
    BringWindowToTop: user32.func("BringWindowToTop", "bool", ["uintptr_t"]),
    SendInput: user32.func("SendInput", "uint32", ["uint32", koffi.pointer(INPUT), "int"]),
    GetCurrentThreadId: kernel32.func("GetCurrentThreadId", "uint32", []),
    AttachThreadInput: user32.func("AttachThreadInput", "bool", ["uint32", "uint32", "bool"]),
    GetWindowThreadProcessId: user32.func("GetWindowThreadProcessId", "uint32", ["uintptr_t", u32Out]),
    FlashWindowEx: user32.func("FlashWindowEx", "bool", [koffi.pointer(FLASHWINFO)]),
    AllowSetForegroundWindow: user32.func("AllowSetForegroundWindow", "bool", ["uint32"]),
    OpenProcess: kernel32.func("OpenProcess", "uintptr_t", ["uint32", "bool", "uint32"]),
    CloseHandle: kernel32.func("CloseHandle", "bool", ["uintptr_t"]),
    OpenProcessToken: advapi32.func("OpenProcessToken", "bool", ["uintptr_t", "uint32", hOut]),
    GetTokenInformation: advapi32.func("GetTokenInformation", "bool", [
      "uintptr_t", "int", u32Out, "uint32", u32Out,
    ]),
    inputSize: koffi.sizeof(INPUT),
    flashInfoSize: koffi.sizeof(FLASHWINFO),
    makeAltKeyUpInput: () => ({
      type: INPUT_KEYBOARD,
      ki: { wVk: VK_MENU, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 },
      tail: [0, 0, 0, 0, 0, 0, 0, 0],
    }),
    makeFlashInfo: (hwnd: number) => ({
      cbSize: koffi.sizeof(FLASHWINFO),
      hwnd,
      dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
      uCount: 0,
      dwTimeout: 0,
    }),
  } as unknown as Win32Focus;

  // Wrap the handle-returning calls so callers always see plain numbers.
  const raw = bound;
  bound = {
    ...raw,
    GetForegroundWindow: () => num(raw.GetForegroundWindow()),
    OpenProcess: (a, i, p) => num(raw.OpenProcess(a, i, p)),
    OpenProcessToken: (h, a, out) => {
      const ok = raw.OpenProcessToken(h, a, out);
      out[0] = num(out[0]);
      return ok;
    },
    GetCurrentThreadId: () => num(raw.GetCurrentThreadId()),
    GetWindowThreadProcessId: (h, pid) => {
      const tid = num(raw.GetWindowThreadProcessId(h, pid));
      pid[0] = num(pid[0]);
      return tid;
    },
  };
  return bound;
}

/** Owning process elevation: true/false, or null when the token cannot be read. */
export function isElevated(pid: number): boolean | null {
  const w = loadWin32Focus();
  const proc = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!proc) return null;
  try {
    const tok = [0];
    if (!w.OpenProcessToken(proc, TOKEN_QUERY, tok) || !tok[0]) return null;
    try {
      const elev = [0];
      const len = [0];
      if (!w.GetTokenInformation(tok[0], TOKEN_ELEVATION_CLASS, elev, 4, len)) return null;
      return elev[0] !== 0;
    } finally {
      w.CloseHandle(tok[0]);
    }
  } finally {
    w.CloseHandle(proc);
  }
}

// ---- Impure steps ----

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** windows.md 3 step 5: poll GetForegroundWindow every 25 ms for up to 300 ms. */
async function pollForeground(w: Win32Focus, hwnd: number): Promise<boolean> {
  const deadline = Date.now() + VERIFY_MS;
  for (;;) {
    if (w.GetForegroundWindow() === hwnd) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

function attachAndForeground(w: Win32Focus, hwnd: number): void {
  const me = w.GetCurrentThreadId();
  const fgThread = w.GetWindowThreadProcessId(w.GetForegroundWindow(), [0]);
  const attach = fgThread !== 0 && fgThread !== me;
  if (attach) w.AttachThreadInput(me, fgThread, true);
  try {
    w.SetForegroundWindow(hwnd);
    w.BringWindowToTop(hwnd);
  } finally {
    if (attach) w.AttachThreadInput(me, fgThread, false);
  }
}

/** Runs the plan. Returns foreground=true as soon as a verify succeeds. */
export async function runFocus(
  steps: readonly Step[],
  w: Win32Focus,
  hwnd: number,
): Promise<{ foreground: boolean }> {
  for (const s of steps) {
    switch (s.kind) {
      case "abort":
        return { foreground: false };
      case "show":
        w.ShowWindow(hwnd, s.cmd);
        break;
      case "alt-key":
        w.SendInput(1, w.makeAltKeyUpInput(), w.inputSize);
        break;
      case "foreground":
        w.SetForegroundWindow(hwnd);
        w.BringWindowToTop(hwnd);
        break;
      case "attach":
        attachAndForeground(w, hwnd);
        break;
      case "verify":
        if (await pollForeground(w, hwnd)) return { foreground: true };
        break;
      case "flash":
        w.FlashWindowEx(w.makeFlashInfo(hwnd));
        return { foreground: false };
    }
  }
  return { foreground: false };
}

interface TabRow {
  index: number;
  name: string;
  selected: boolean;
}

function parseTabs(stdout: string): WtTab[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((r): TabRow => {
        const row = r as Partial<TabRow>;
        return { index: Number(row.index), name: String(row.name ?? ""), selected: row.selected === true };
      })
      .filter((t) => Number.isInteger(t.index));
  } catch {
    return [];
  }
}

/** windows.md 4: UI Automation tab list, pick by chooseTab, select it. */
export async function selectWtTab(deps: { exec: Exec; env: PlatformEnv }, hwnd: number): Promise<boolean> {
  const dir = layout().psDir;
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
  const listed = await deps.exec(
    "powershell.exe",
    [...base, path.join(dir, "wt-tabs.ps1"), String(hwnd)],
    { timeoutMs: HELPER_TIMEOUT_MS },
  );
  if (listed.code !== 0 || listed.timedOut) return false;
  const index = chooseTab(parseTabs(listed.stdout));
  if (index === null) return false;
  const sel = await deps.exec(
    "powershell.exe",
    [...base, path.join(dir, "wt-select-tab.ps1"), String(hwnd), String(index)],
    { timeoutMs: HELPER_TIMEOUT_MS },
  );
  if (sel.code !== 0 || sel.timedOut) return false;
  try {
    return (JSON.parse(sel.stdout) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function fail(code: FocusResult["code"], detail: string): FocusResult {
  return { status: "failed", code, detail: detail.slice(0, 200), at: new Date().toISOString() };
}

async function focusOnce(
  deps: { exec: Exec; env: PlatformEnv },
  target: ResolvedTarget,
  opts: FocusOptions,
): Promise<FocusResult> {
  const win = target.window;
  if (target.capability === "none" || win === null) {
    return fail("unsupported", target.reason ?? "no_window_found");
  }
  const w = loadWin32Focus();
  const hwnd = parseHandle(win.handle);
  if (!w.IsWindow(hwnd)) return fail("not_found", "window no longer exists");

  const owner = [0];
  w.GetWindowThreadProcessId(hwnd, owner);
  if (owner[0] !== win.pid) return fail("not_found", "handle now belongs to another process");

  if (opts.fromActivation) w.AllowSetForegroundWindow(ASFW_ANY);

  const elevated = isElevated(win.pid) === true && isElevated(process.pid) !== true;
  const plan = planFocus({ isWindow: true, isIconic: w.IsIconic(hwnd), elevated }, opts);
  const first = plan[0];
  if (first?.kind === "abort") return fail(first.code, first.detail);

  const at = () => new Date().toISOString();
  const run = await runFocus(plan, w, hwnd);
  if (!run.foreground) return focusResultFor({ foreground: false, tab: "none" }, at());

  if (target.inner?.wtTabTitle === undefined) {
    return focusResultFor({ foreground: true, tab: "none" }, at());
  }
  const tabOk = await selectWtTab(deps, hwnd);
  if (!(await pollForeground(w, hwnd))) return focusResultFor({ foreground: false, tab: "none" }, at());
  return focusResultFor({ foreground: true, tab: tabOk ? "ok" : "failed" }, at());
}

export function createFocus(deps: { exec: Exec; env: PlatformEnv; discover: Discover }): {
  focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult>;
} {
  return {
    async focus(target, opts) {
      try {
        return await focusOnce(deps, target, opts);
      } catch (err) {
        return fail("error", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
