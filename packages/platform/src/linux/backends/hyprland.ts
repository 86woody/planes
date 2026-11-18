import type { Exec } from "../../exec.js";
import type { FocusOptions } from "../../types.js";
import { focusResult, pollUntil, type LinuxBackend, type LinuxWindow } from "./select.js";

interface HyprClient {
  address?: string;
  pid?: number;
  title?: string;
  class?: string;
  fullscreen?: number;
  hidden?: boolean;
}

function toWindow(c: HyprClient, stackIndex: number): LinuxWindow | null {
  if (typeof c.address !== "string" || typeof c.pid !== "number") return null;
  return {
    id: c.address,
    pid: c.pid,
    title: c.title ?? "",
    app: (c.class ?? "").toLowerCase(),
    stackIndex,
    fullscreen: c.fullscreen ?? 0,
    minimized: c.hidden === true,
  };
}

/** `hyprctl clients -j`. */
export function parseHyprClients(json: string): LinuxWindow[] {
  const arr = JSON.parse(json) as HyprClient[];
  const out: LinuxWindow[] = [];
  for (const c of arr) {
    const w = toWindow(c, out.length);
    if (w !== null) out.push(w);
  }
  return out;
}

/** `hyprctl activewindow -j`: one object, or {} when nothing is focused. */
export function parseHyprActive(json: string): LinuxWindow | null {
  return toWindow(JSON.parse(json) as HyprClient, 0);
}

export function createHyprland(deps: { exec: Exec }): LinuxBackend {
  const { exec } = deps;

  async function list(): Promise<LinuxWindow[]> {
    const r = await exec("hyprctl", ["clients", "-j"]);
    if (r.code !== 0) return [];
    try {
      return parseHyprClients(r.stdout);
    } catch {
      return [];
    }
  }

  async function active(): Promise<LinuxWindow | null> {
    const r = await exec("hyprctl", ["activewindow", "-j"]);
    if (r.code !== 0) return null;
    try {
      return parseHyprActive(r.stdout);
    } catch {
      return null;
    }
  }

  return {
    list,
    active,

    async focus(w: LinuxWindow, opts: FocusOptions) {
      const r = await exec("hyprctl", ["dispatch", "focuswindow", `address:${w.id}`]);
      if (r.code !== 0) return focusResult("error", r.stderr.trim() || "hyprctl focuswindow failed");
      const wantMaximize =
        opts.maximize === "always" || (opts.maximize === "if-minimized" && w.minimized === true);
      // Mode 1 is maximize (keeps gaps and bar); never toggles off an existing fullscreen.
      if (wantMaximize && (w.fullscreen ?? 0) === 0) {
        await exec("hyprctl", ["dispatch", "fullscreen", "1"]);
      }
      const isActive = async (): Promise<boolean> => (await active())?.id === w.id;
      if (await pollUntil(isActive)) return focusResult("focused");
      return focusResult("error", "Hyprland did not focus the window");
    },
  };
}
