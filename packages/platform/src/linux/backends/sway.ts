import type { Exec } from "../../exec.js";
import type { FocusOptions } from "../../types.js";
import { focusResult, pollUntil, type LinuxBackend, type LinuxWindow } from "./select.js";

export type SwayWindow = LinuxWindow & { focused: boolean };

interface SwayNode {
  id?: number;
  pid?: number;
  name?: string;
  app_id?: string | null;
  focused?: boolean;
  fullscreen_mode?: number;
  window_properties?: { class?: string } | null;
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
}

/** `swaymsg -t get_tree -r`: every node with a pid (a view) in nodes and floating_nodes, depth first. */
export function parseSwayTree(json: string): SwayWindow[] {
  const out: SwayWindow[] = [];
  const walk = (n: SwayNode): void => {
    if (typeof n.pid === "number" && typeof n.id === "number") {
      out.push({
        id: String(n.id),
        pid: n.pid,
        title: n.name ?? "",
        app: n.app_id ?? n.window_properties?.class ?? "",
        stackIndex: out.length,
        fullscreen: n.fullscreen_mode ?? 0,
        focused: n.focused === true,
      });
    }
    for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
  };
  walk(JSON.parse(json) as SwayNode);
  return out;
}

export function createSway(deps: { exec: Exec }): LinuxBackend {
  const { exec } = deps;

  async function list(): Promise<SwayWindow[]> {
    const r = await exec("swaymsg", ["-t", "get_tree", "-r"]);
    if (r.code !== 0) return [];
    try {
      return parseSwayTree(r.stdout);
    } catch {
      return [];
    }
  }

  return {
    list,

    async active() {
      return (await list()).find((w) => w.focused) ?? null;
    },

    async focus(w: LinuxWindow, opts: FocusOptions) {
      const r = await exec("swaymsg", [`[con_id=${w.id}] focus`]);
      if (r.code !== 0) return focusResult("error", r.stderr.trim() || "swaymsg focus failed");
      const isFocused = async (): Promise<boolean> => (await list()).some((x) => x.id === w.id && x.focused);
      if (!(await pollUntil(isFocused))) return focusResult("error", "sway did not focus the container");
      // Tiling layouts have no maximize; fullscreen is never touched (linux.md 3.2).
      const wantMaximize =
        opts.maximize === "always" || (opts.maximize === "if-minimized" && w.minimized === true);
      return focusResult("focused", wantMaximize ? "tiling: maximize skipped" : "");
    },
  };
}
