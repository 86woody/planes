import type { IngestOrigin, Host } from "@mc/contracts";
import type { Exec } from "../exec.js";
import type { NativeWindow, PlatformEnv, ResolvedTarget } from "../types.js";
import {
  enumerateWindows,
  foregroundHwnd,
  hexToHwnd,
  normHex,
  windowInfo,
  type ProcessCache,
  type WindowInfo,
} from "./win32.js";

export interface Discover {
  resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget>;
  windowExists(w: NativeWindow): Promise<boolean>;
  foregroundWindow(): Promise<NativeWindow | null>;
  listWindows(appNames: string[]): Promise<NativeWindow[]>;
}

export interface ChooseInput {
  origin: IngestOrigin;
  host: Host;
  /** Visible top-level windows (one EnumWindows pass). */
  windows: WindowInfo[];
  /** Lookup for the hook-provided HWNDs (console, owner, root owner). Must not focus anything. */
  byHwnd: (hex: string) => WindowInfo | undefined;
}

const VSCODE_EXES = new Set(["code.exe", "code - insiders.exe", "code-insiders.exe", "codium.exe", "cursor.exe"]);

const none = (reason: NonNullable<ResolvedTarget["reason"]>): ResolvedTarget => ({
  window: null,
  inner: null,
  capability: "none",
  reason,
});

function nativeOf(w: WindowInfo): NativeWindow {
  return { os: "windows", handle: w.hwnd, pid: w.pid, app: w.exe, title: w.title };
}

/** The target for a window already chosen by one of the steps in windows.md 2. */
function targetFor(w: WindowInfo): ResolvedTarget {
  if (w.elevated) return none("target_elevated");
  if (w.exe.toLowerCase() === "windowsterminal.exe") {
    return { window: nativeOf(w), inner: { wtTabTitle: w.title }, capability: "full", reason: null };
  }
  if (w.className === "ConsoleWindowClass") {
    return { window: nativeOf(w), inner: null, capability: "full", reason: null };
  }
  return { window: nativeOf(w), inner: null, capability: "window", reason: null };
}

/**
 * Pure decision logic for windows.md 2 (steps 1-5, 2.1) and the WSL row of 1.
 * Takes the windows and lookups already gathered, so it runs on any OS with fixtures.
 */
export function chooseWindow(input: ChooseInput): ResolvedTarget {
  const { origin, host, windows, byHwnd } = input;
  if (host.kind === "remote") return none("remote_session");

  // WSL: the hook runs in Linux, its ancestry is Linux PIDs. One Windows Terminal window or nothing.
  if (origin.os !== "windows") {
    const wt = windows.filter((w) => w.className === "CASCADIA_HOSTING_WINDOW_CLASS" && w.visible);
    const only = wt[0];
    if (wt.length !== 1 || only === undefined) return none("no_window_found");
    if (only.elevated) return none("target_elevated");
    return { window: nativeOf(only), inner: null, capability: "window", reason: null };
  }

  const con = origin.console;
  const consoleHwnd = con?.consoleHwnd ?? null;
  const ownerHwnd = con?.ownerHwnd ?? null;

  // Step 1: hook-provided owner that is a Windows Terminal or VS Code window.
  if (ownerHwnd) {
    const owner = byHwnd(ownerHwnd);
    if (owner && (owner.exe.toLowerCase() === "windowsterminal.exe" || VSCODE_EXES.has(owner.exe.toLowerCase()))) {
      return targetFor(owner);
    }
  }

  // Step 2: classic console window. Step 3: pseudoconsole resolves through its root owner.
  if (consoleHwnd) {
    const cw = byHwnd(consoleHwnd);
    if (cw?.className === "ConsoleWindowClass") return targetFor(cw);
    if (cw?.className === "PseudoConsoleWindow" && cw.rootOwner && cw.rootOwner !== cw.hwnd) {
      const root = byHwnd(cw.rootOwner);
      if (root) return targetFor(root);
    }
  }

  // Step 4: ancestry scan, nearest first. Several candidates in one process is ambiguous (2.1).
  for (const a of origin.ancestry) {
    const candidates = windows.filter((w) => w.pid === a.pid && w.visible && w.owner === null && w.title !== "");
    if (candidates.length === 0) continue;
    if (candidates.length > 1) return none("no_window_found");
    const only = candidates[0];
    if (only === undefined) continue;
    return targetFor(only);
  }

  return none("no_window_found");
}

/** Impure gather (one EnumWindows pass plus the hook HWNDs), then chooseWindow. */
export function createDiscover(deps: { exec: Exec; env: PlatformEnv }): Discover {
  void deps; // all Win32 calls go through koffi (win32.ts); exec stays in the frozen signature.

  const lookup = async (hex: string, cache: ProcessCache): Promise<WindowInfo | undefined> => {
    try {
      return await windowInfo(hexToHwnd(hex), cache);
    } catch {
      return undefined;
    }
  };

  return {
    async resolveTarget(origin, host) {
      try {
        const cache: ProcessCache = new Map();
        const windows = await enumerateWindows(cache);
        const extra = new Map<string, WindowInfo>();
        for (const hex of [origin.console?.ownerHwnd, origin.console?.consoleHwnd]) {
          if (!hex) continue;
          const info = await lookup(hex, cache);
          if (!info) continue;
          extra.set(info.hwnd, info);
          if (info.rootOwner) {
            const root = await lookup(info.rootOwner, cache);
            if (root) extra.set(root.hwnd, root);
          }
        }
        const byHwnd = (hex: string): WindowInfo | undefined => {
          const key = normHex(hex);
          return extra.get(key) ?? windows.find((w) => w.hwnd === key);
        };
        return chooseWindow({ origin, host, windows, byHwnd });
      } catch {
        return none("platform_error");
      }
    },

    async windowExists(w) {
      try {
        const info = await windowInfo(hexToHwnd(w.handle));
        return info !== undefined && info.pid === w.pid;
      } catch {
        return false;
      }
    },

    async foregroundWindow() {
      try {
        const h = await foregroundHwnd();
        if (h === 0) return null;
        const info = await windowInfo(h);
        return info ? nativeOf(info) : null;
      } catch {
        return null;
      }
    },

    async listWindows(appNames) {
      try {
        const wanted = new Set(appNames.map((n) => n.toLowerCase().replace(/\.exe$/, "")));
        const windows = await enumerateWindows();
        return windows
          .filter((w) => w.owner === null && w.title !== "")
          .filter((w) => wanted.has(w.exe.toLowerCase().replace(/\.exe$/, "")))
          .map(nativeOf);
      } catch {
        return [];
      }
    },
  };
}
