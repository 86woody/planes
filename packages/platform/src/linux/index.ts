import { readFile } from "node:fs/promises";
import type { Capabilities, FocusResult, Host, IngestOrigin, OsNotification, RestoreReason } from "@mc/contracts";
import { exec, which } from "../exec.js";
import type { NativeWindow, PlatformAdapter, PlatformEnv, ResolvedTarget } from "../types.js";
import { createBackendSet, createDiscover, parseProcStat, safely } from "./discover.js";
import { createFocus } from "./focus.js";
import { createNotify } from "./notify.js";
import { focusResult } from "./backends/select.js";

type Issue = Capabilities["issues"][number];

/** linux.md 7: each external tool, what needs it, and the fix text. */
const TOOL_FIX: Record<string, { code: string; fix: string }> = {
  wmctrl: {
    code: "linux_missing_wmctrl",
    fix: "sudo apt install wmctrl x11-utils (Debian/Ubuntu), or sudo dnf install wmctrl xprop",
  },
  xprop: {
    code: "linux_missing_xprop",
    fix: "sudo apt install x11-utils (Debian/Ubuntu), or sudo dnf install xprop",
  },
  swaymsg: { code: "linux_missing_swaymsg", fix: "swaymsg ships with the sway compositor" },
  hyprctl: { code: "linux_missing_hyprctl", fix: "hyprctl ships with Hyprland" },
};

/** Guards every adapter method so none throws or rejects (PA-01). */
function guard<A extends unknown[], R>(f: (...a: A) => Promise<R>, fallback: R): (...a: A) => Promise<R> {
  return (...a) => safely(() => f(...a), fallback);
}

async function processAlive(pid: number, startTime: string | null): Promise<boolean> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (raw === null) return false;
  if (startTime === null) return true;
  const st = parseProcStat(raw);
  return st !== null && st.starttime === startTime;
}

export async function create(env: PlatformEnv): Promise<PlatformAdapter> {
  const discover = createDiscover({ exec, env });
  const focus = createFocus({ exec, env, discover });
  const notify = createNotify({ exec, env });
  const sets = createBackendSet({ exec, env });

  async function capabilities(): Promise<Capabilities> {
    const displayEnv = env.displayEnv();
    const display: Capabilities["display"] =
      displayEnv.WAYLAND_DISPLAY ? "wayland" : displayEnv.DISPLAY ? "x11" : null;
    const issues: Issue[] = [];
    const missing = async (tool: keyof typeof TOOL_FIX): Promise<boolean> => {
      if ((await which(tool)) !== null) return false;
      const t = TOOL_FIX[tool];
      if (t !== undefined) {
        issues.push({ code: t.code, severity: "warn", message: `${tool} is not installed`, fix: t.fix });
      }
      return true;
    };

    const name = sets.pick(null)?.name ?? "none";
    let focusLevel: Capabilities["focus"] = "none";
    if (name === "x11") {
      const a = await missing("wmctrl");
      const b = await missing("xprop");
      focusLevel = a || b ? "none" : "full";
    } else if (name === "sway") {
      focusLevel = (await missing("swaymsg")) ? "none" : "full";
    } else if (name === "hyprland") {
      focusLevel = (await missing("hyprctl")) ? "none" : "full";
    } else if (name === "kwin") {
      focusLevel = "full";
    } else if (name === "gnome-extension") {
      if (await sets.gnomeAvailable()) {
        focusLevel = "full";
      } else {
        issues.push({
          code: "gnome_extension_missing",
          severity: "warn",
          message: "The Window Calls GNOME extension is not running",
          fix: "install Window Calls from extensions.gnome.org (id 4724)",
        });
      }
    } else {
      issues.push({
        code: "wayland_unsupported_compositor",
        severity: "info",
        message: "This compositor has no focus backend",
        fix: "the session window is focused manually; the cwd is copied to the clipboard",
      });
    }

    const probe = await safely(() => notify.probe(), { notify: false, notifyClick: false, issues: [] as Issue[] });
    issues.push(...probe.issues);
    return {
      os: "linux",
      display,
      focus: focusLevel,
      notify: probe.notify,
      notifyClick: probe.notifyClick,
      issues,
    };
  }

  return {
    os: "linux",
    capabilities: guard(capabilities, {
      os: "linux",
      display: null,
      focus: "none",
      notify: false,
      notifyClick: false,
      issues: [],
    }),
    resolveTarget: guard(
      (origin: IngestOrigin, host: Host): Promise<ResolvedTarget> => discover.resolveTarget(origin, host),
      { window: null, inner: null, capability: "none", reason: "no_window_found" as RestoreReason },
    ),
    windowExists: guard((w: NativeWindow) => discover.windowExists(w), false),
    foregroundWindow: guard(() => discover.foregroundWindow(), null),
    listWindows: guard((appNames: string[]) => discover.listWindows(appNames), []),
    focus: guard(
      (target: ResolvedTarget, opts: Parameters<PlatformAdapter["focus"]>[1]): Promise<FocusResult> =>
        focus.focus(target, opts),
      focusResult("error", "focus failed"),
    ),
    notify: guard(
      (n: OsNotification, onClick: (sessionId: string | null) => void) => notify.notify(n, onClick),
      null,
    ),
    withdraw: guard((h: { id: string }) => notify.withdraw(h), undefined),
    processAlive: guard(processAlive, false),
    dispose: guard(async () => {
      sets.dispose();
      await notify.dispose();
    }, undefined),
  };
}
