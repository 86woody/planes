import type { Exec } from "../../exec.js";
import type { FocusOptions } from "../../types.js";
import { focusResult, pollUntil, type LinuxBackend, type LinuxWindow } from "./select.js";

/** `wmctrl -lpx`: id, desktop, pid, WM_CLASS, host, title (title may contain spaces). */
export function parseWmctrl(stdout: string): LinuxWindow[] {
  const out: LinuxWindow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trimEnd());
    if (!m) continue;
    const [, id = "", , pid = "0", wmClass = "", , title = ""] = m;
    out.push({
      id,
      pid: Number(pid),
      title,
      app: (wmClass.split(".")[0] ?? "").toLowerCase(),
      stackIndex: out.length,
    });
  }
  return out;
}

/** `xprop -root _NET_CLIENT_LIST_STACKING` -> window ids bottom to top. */
export function parseStacking(stdout: string): string[] {
  const hash = stdout.indexOf("#");
  if (hash < 0) return [];
  return stdout.slice(hash + 1).match(/0x[0-9a-fA-F]+/g) ?? [];
}

/** `xprop -root _NET_ACTIVE_WINDOW` -> the id, or null for 0x0 / absent. */
export function parseActiveWindow(stdout: string): string | null {
  const ids = stdout.match(/0x[0-9a-fA-F]+/g) ?? [];
  const last = ids[ids.length - 1];
  if (last === undefined || Number(last) === 0) return null;
  return last;
}

/** X ids are compared numerically: wmctrl prints 0x-padded hex, xprop does not pad. */
export function sameX11Id(a: string, b: string): boolean {
  return Number(a) === Number(b);
}

export function createX11(deps: { exec: Exec }): LinuxBackend {
  const { exec } = deps;

  async function activeId(): Promise<string | null> {
    const r = await exec("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
    return r.code === 0 ? parseActiveWindow(r.stdout) : null;
  }

  async function list(): Promise<LinuxWindow[]> {
    const r = await exec("wmctrl", ["-lpx"]);
    if (r.code !== 0) return [];
    const windows = parseWmctrl(r.stdout);
    const s = await exec("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"]);
    if (s.code === 0) {
      const order = parseStacking(s.stdout);
      for (const w of windows) {
        const idx = order.findIndex((id) => sameX11Id(id, w.id));
        w.stackIndex = idx;
      }
    }
    return windows;
  }

  return {
    list,

    async active() {
      const id = await activeId();
      if (id === null) return null;
      return (await list()).find((w) => sameX11Id(w.id, id)) ?? null;
    },

    async focus(w: LinuxWindow, opts: FocusOptions) {
      // linux.md 3.1: un-minimize, raise (pager source, switches desktop), maximize per policy.
      await exec("wmctrl", ["-i", "-r", w.id, "-b", "remove,hidden"]);
      const raised = await exec("wmctrl", ["-i", "-a", w.id]);
      if (raised.code !== 0) {
        return focusResult("unsupported", raised.stderr.trim() || "wmctrl could not activate the window");
      }
      const wantMaximize =
        opts.maximize === "always" || (opts.maximize === "if-minimized" && w.minimized === true);
      if (wantMaximize) {
        await exec("wmctrl", ["-i", "-r", w.id, "-b", "add,maximized_vert,maximized_horz"]);
      }
      const isActive = async (): Promise<boolean> => {
        const id = await activeId();
        return id !== null && sameX11Id(id, w.id);
      };
      if (await pollUntil(isActive)) return focusResult("focused");
      // Fallback: xdotool if installed (a missing binary comes back as code null, not an error).
      const xd = await exec("xdotool", ["windowactivate", "--sync", w.id]);
      if (xd.code === 0 && (await pollUntil(isActive))) return focusResult("focused");
      await exec("wmctrl", ["-i", "-r", w.id, "-b", "add,demands_attention"]);
      return focusResult("flashed", "X11 focus stealing prevented; window flashed");
    },
  };
}
