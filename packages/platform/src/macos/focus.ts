import type { FocusResult } from "@mc/contracts";
import type { Exec } from "../exec.js";
import type { FocusOptions, NativeWindow, PlatformEnv, ResolvedTarget } from "../types.js";
import {
  findTab,
  parseJson,
  runOsa,
  tmuxActiveClient,
  tmuxSocketFor,
  type Discover,
  type OsaErrorKind,
} from "./discover.js";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScreenFrame {
  primaryHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** macos.md 3.2: Cocoa visibleFrame to top-left coordinates. Integers only. */
export function topLeftBounds(s: ScreenFrame): Bounds {
  const left = Math.round(s.x);
  const top = Math.round(s.primaryHeight - (s.y + s.height));
  const right = left + Math.round(s.width);
  const bottom = top + Math.round(s.height);
  return { left, top, right, bottom };
}

function asScreenFrame(v: unknown): ScreenFrame | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const keys = ["primaryHeight", "x", "y", "width", "height"] as const;
  for (const k of keys) if (typeof o[k] !== "number") return null;
  return {
    primaryHeight: o.primaryHeight as number,
    x: o.x as number,
    y: o.y as number,
    width: o.width as number,
    height: o.height as number,
  };
}

/** Visible frame of the main screen as top-left bounds, or null. */
export async function screenFrame(exec: Exec): Promise<Bounds | null> {
  const r = await runOsa(exec, "screen-frame.js", []);
  if (!r.ok) return null;
  const s = asScreenFrame(parseJson(r.stdout));
  return s === null ? null : topLeftBounds(s);
}

/**
 * linux.md 4.1 step 3 as argv lists, in order: switch-client, select-window, select-pane.
 * Every command carries `-S <socket>` when the socket is known.
 */
export function tmuxInnerCommands(socket: string | undefined, pane: string, clientTty: string): string[][] {
  const s = socket !== undefined ? ["-S", socket] : [];
  return [
    [...s, "switch-client", "-c", clientTty, "-t", pane],
    [...s, "select-window", "-t", pane],
    [...s, "select-pane", "-t", pane],
  ];
}

const result = (status: FocusResult["status"], code: FocusResult["code"], detail: string): FocusResult => ({
  status,
  code,
  detail,
  at: new Date().toISOString(),
});

function failFromOsa(kind: OsaErrorKind | "timeout", stderr: string): FocusResult {
  const first = stderr.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  switch (kind) {
    case "automation_denied":
      return result("failed", "permission_denied", "macos_automation_denied: Automation for the terminal app is not granted");
    case "accessibility_denied":
      return result("failed", "permission_denied", "macos_accessibility_denied: Accessibility is not granted");
    case "timeout":
      return result("failed", "timeout", "osascript timed out");
    default:
      return result("failed", "error", first !== "" ? first : "osascript failed");
  }
}

type Outer = { kind: "ok"; innerFailed: boolean } | { kind: "fail"; result: FocusResult };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createFocus(deps: { exec: Exec; env: PlatformEnv; discover: Discover }): {
  focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult>;
} {
  const { exec, discover } = deps;

  function wantMaximize(policy: FocusOptions["maximize"], wasMinimized: boolean): boolean {
    return policy === "always" || (policy === "if-minimized" && wasMinimized);
  }

  async function clientTty(pane: string): Promise<string | null> {
    const client = await tmuxActiveClient(exec, tmuxSocketFor(pane));
    return client === null ? null : client.tty;
  }

  async function raiseScripted(w: NativeWindow, target: ResolvedTarget, opts: FocusOptions): Promise<Outer> {
    const app: "Terminal" | "iTerm2" = w.app === "iTerm2" ? "iTerm2" : "Terminal";
    const tmuxPane = target.inner?.tmuxPane;
    const tty = target.inner?.tty ?? (tmuxPane !== undefined ? await clientTty(tmuxPane) : null);
    if (tty === null || tty === undefined) {
      // No tab to address: activate the app only, the inner selector is reported as not done.
      const r = await exec("/usr/bin/open", ["-a", app]);
      return r.code === 0 ? { kind: "ok", innerFailed: true } : { kind: "fail", result: result("failed", "error", "open -a failed") };
    }

    const lookup = await findTab(exec, app, tty, "");
    if (lookup.kind === "failed") return { kind: "fail", result: failFromOsa(lookup.reason, lookup.stderr) };
    if (lookup.kind === "none") return { kind: "fail", result: result("failed", "not_found", "tab for tty not found") };

    const tab = lookup.tab;
    const frame = wantMaximize(opts.maximize, tab.minimized) ? await screenFrame(exec) : null;
    const max = frame === null ? "0" : "1";
    const b = frame ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const bounds = [String(b.left), String(b.top), String(b.right), String(b.bottom)];
    const r =
      app === "Terminal"
        ? await runOsa(exec, "terminal-focus.applescript", [String(tab.windowId), String(tab.tab), max, ...bounds])
        : await runOsa(exec, "iterm-focus.applescript", [String(tab.windowId), String(tab.tab), tab.session ?? "", max, ...bounds]);
    if (!r.ok) return { kind: "fail", result: failFromOsa(r.kind, r.stderr) };
    return { kind: "ok", innerFailed: false };
  }

  async function raiseAx(w: NativeWindow, opts: FocusOptions): Promise<Outer> {
    const frame = opts.maximize === "never" ? null : await screenFrame(exec);
    const b = frame ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const r = await runOsa(exec, "ax-focus.js", [
      String(w.pid),
      w.title,
      opts.maximize,
      String(b.left),
      String(b.top),
      String(b.right),
      String(b.bottom),
    ]);
    if (!r.ok) return { kind: "fail", result: failFromOsa(r.kind, r.stderr) };
    const v = parseJson(r.stdout) as { ok?: unknown } | null;
    if (v === null || typeof v !== "object" || v.ok !== true) {
      return { kind: "fail", result: result("failed", "not_found", "window not found in process") };
    }
    return { kind: "ok", innerFailed: false };
  }

  async function raiseOuter(w: NativeWindow, target: ResolvedTarget, opts: FocusOptions): Promise<Outer> {
    if (w.app === "Terminal" || w.app === "iTerm2") return raiseScripted(w, target, opts);
    if (w.app === "WezTerm" || w.app === "kitty") {
      const r = await exec("/usr/bin/open", ["-a", w.app]);
      return r.code === 0 ? { kind: "ok", innerFailed: false } : { kind: "fail", result: result("failed", "error", "open -a failed") };
    }
    return raiseAx(w, opts);
  }

  async function selectTmux(pane: string): Promise<boolean> {
    const socket = tmuxSocketFor(pane);
    const client = await tmuxActiveClient(exec, socket);
    if (client === null) return false;
    for (const args of tmuxInnerCommands(socket, pane, client.tty)) {
      const r = await exec("tmux", args);
      if (r.code !== 0) return false;
    }
    return true;
  }

  async function frontmostWithin(pid: number, budgetMs: number): Promise<boolean> {
    const end = Date.now() + budgetMs;
    for (;;) {
      const f = await discover.foregroundWindow();
      if (f !== null && f.pid === pid) return true;
      if (Date.now() >= end) return false;
      await sleep(50);
    }
  }

  // macos.md 3.4: verify, never assume.
  async function verify(w: NativeWindow): Promise<"ok" | "flashed" | "title"> {
    let ok = await frontmostWithin(w.pid, 500);
    if (!ok) {
      await runOsa(exec, "ax-focus.js", [String(w.pid), w.title, "never", "0", "0", "0", "0"]);
      ok = await frontmostWithin(w.pid, 500);
    }
    if (!ok) return "flashed";
    if (w.title !== "") {
      const f = await discover.foregroundWindow();
      if (f !== null && f.title !== "" && !f.title.includes(w.title)) return "title";
    }
    return "ok";
  }

  async function runFocus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult> {
    if (target.capability === "none") return result("failed", "unsupported", target.reason ?? "no_window_found");
    const w = target.window;
    if (w === null) return result("failed", "not_found", "no window");
    if (!(await discover.windowExists(w))) return result("failed", "not_found", "window owner exited");

    const outer = await raiseOuter(w, target, opts);
    if (outer.kind === "fail") return outer.result;

    let innerOk = !outer.innerFailed;
    const pane = target.inner?.tmuxPane;
    if (pane !== undefined) innerOk = (await selectTmux(pane)) && innerOk;
    const wez = target.inner?.weztermPane;
    if (wez !== undefined) {
      const r = await exec("wezterm", ["cli", "activate-pane", "--pane-id", wez]);
      innerOk = r.code === 0 && innerOk;
    }
    const kitty = target.inner?.kittyWindowId;
    if (kitty !== undefined) {
      const r = await exec("kitty", ["@", "focus-window", "--match", `id:${kitty}`]);
      innerOk = r.code === 0 && innerOk;
    }

    const verdict = await verify(w);
    if (verdict === "flashed") return result("partial", "flashed", "macos activation refused");
    if (verdict === "title") return result("partial", "focused_window_only", "frontmost window title does not match");
    if (!innerOk) return result("partial", "focused_window_only", "inner selector not selected");
    return result("ok", "focused", "frontmost window verified");
  }

  return {
    async focus(target, opts) {
      try {
        return await runFocus(target, opts);
      } catch (err) {
        return result("failed", "error", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
