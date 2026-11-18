import type { FocusResult } from "@mc/contracts";
import type { Exec } from "../exec.js";
import type { FocusOptions, InnerSelector, NativeWindow, PlatformEnv, ResolvedTarget } from "../types.js";
import { createBackendSet, safely, type Discover } from "./discover.js";
import { focusResult, type LinuxWindow } from "./backends/select.js";
import { focusTmuxPane, listTmuxClients, mostRecentClient, paneSocket } from "./tmux.js";

/** Inner selector (linux.md 4). Returns false when the selector could not be applied. */
async function focusInner(exec: Exec, env: PlatformEnv, inner: InnerSelector): Promise<boolean> {
  if (inner.tmuxPane !== undefined) {
    const socket = paneSocket(inner.tmuxPane);
    if (socket === null) return false;
    const client = mostRecentClient(await listTmuxClients(exec, socket));
    if (client === null) return false;
    return focusTmuxPane(exec, socket, inner.tmuxPane, client);
  }
  const displayEnv = env.displayEnv();
  if (inner.kittyWindowId !== undefined) {
    const listen = displayEnv.KITTY_LISTEN_ON;
    if (listen === undefined || listen === "") return false;
    const r = await exec("kitty", ["@", "--to", listen, "focus-window", "--match", `id:${inner.kittyWindowId}`]);
    return r.code === 0;
  }
  if (inner.weztermPane !== undefined) {
    const r = await exec("wezterm", ["cli", "activate-pane", "--pane-id", inner.weztermPane], { env: displayEnv });
    return r.code === 0;
  }
  return true;
}

export function createFocus(deps: { exec: Exec; env: PlatformEnv; discover: Discover }): {
  focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult>;
} {
  const { exec, env, discover } = deps;
  const sets = createBackendSet({ exec, env });

  async function focusWindow(
    w: NativeWindow,
    inner: InnerSelector | null,
    opts: FocusOptions,
  ): Promise<FocusResult> {
    if (!(await discover.windowExists(w))) return focusResult("not_found", "window no longer exists");
    const pick = sets.pick(null);
    if (pick === null) return focusResult("unsupported", "wayland_unsupported_compositor");

    const windows = await safely<LinuxWindow[]>(() => pick.backend.list(), []);
    let live: LinuxWindow | null = windows.find((x) => x.id === w.handle) ?? null;
    if (live === null) {
      // linux.md 8: re-resolve once by pid and title before giving up.
      const again = windows.filter((x) => x.pid === w.pid && x.title === w.title);
      const [only] = again;
      if (again.length === 1 && only !== undefined) live = only;
    }
    if (live === null) return focusResult("not_found", "window id stale");

    const res = await pick.backend.focus(live, opts);
    if (res.code !== "focused") return res;

    if (inner !== null && !(await focusInner(exec, env, inner))) {
      return focusResult("focused_window_only", "inner selector could not be applied");
    }
    // PA-03: ok only if the target is foreground after acting, verified rather than assumed.
    const active = await safely<LinuxWindow | null>(() => pick.backend.active(), null);
    if (active?.id !== live.id) return focusResult("error", "window is not foreground after focus");
    return res;
  }

  return {
    async focus(target, opts) {
      // PA-02: no side effects for a target without a window.
      if (target.capability === "none" || target.window === null) {
        return focusResult("unsupported", target.reason ?? "no_window_found");
      }
      try {
        return await focusWindow(target.window, target.inner, opts);
      } catch {
        return focusResult("error", "unexpected focus failure");
      }
    },
  };
}
