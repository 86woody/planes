import type { Capabilities } from "@mc/contracts";
import { exec as baseExec, type Exec } from "../exec.js";
import { processAlive as processAliveRaw } from "../process/index.js";
import type { PlatformAdapter, PlatformEnv } from "../types.js";
import { axTrusted, createDiscover, parseOsascriptError } from "./discover.js";
import { createFocus } from "./focus.js";
import { createNotify } from "./notify.js";

const TERMINAL_SCRIPT = /(terminal|iterm)-(find|focus)\.applescript$/;

export async function create(env: PlatformEnv): Promise<PlatformAdapter> {
  // Whether the last Terminal.app / iTerm2 osascript call was refused by Automation (-1743).
  let automationDenied = false;

  const exec: Exec = async (file, args, opts) => {
    const r = await baseExec(file, args, opts);
    if (file === "/usr/bin/osascript" && args.some((a) => TERMINAL_SCRIPT.test(a))) {
      automationDenied = r.code !== 0 && parseOsascriptError(r.stderr) === "automation_denied";
    }
    return r;
  };

  const discover = createDiscover({ exec, env });
  const focus = createFocus({ exec, env, discover });

  // notify.ts belongs to T044; until it lands its factory throws, so every call is guarded.
  let notifier: ReturnType<typeof createNotify> | null = null;
  const notifyBackend = (): ReturnType<typeof createNotify> => {
    notifier ??= createNotify({ exec, env });
    return notifier;
  };

  async function capabilities(): Promise<Capabilities> {
    const issues: Capabilities["issues"] = [];
    if (!(await axTrusted(exec))) {
      issues.push({
        code: "macos_accessibility_denied",
        severity: "warn",
        message: "Accessibility is not granted: VS Code and other apps cannot be raised or zoomed.",
        fix: "System Settings > Privacy & Security > Accessibility > add the app that runs the daemon",
      });
    }
    if (automationDenied) {
      issues.push({
        code: "macos_automation_denied",
        severity: "warn",
        message: "Automation for Terminal or iTerm2 is not granted: tabs cannot be selected.",
        fix: "System Settings > Privacy & Security > Automation > enable Terminal (and iTerm2) under the app that runs the daemon",
      });
    }
    let probe: { notify: boolean; notifyClick: boolean; issues: Capabilities["issues"] } = {
      notify: false,
      notifyClick: false,
      issues: [],
    };
    try {
      probe = await notifyBackend().probe();
    } catch {
      // notify backend unavailable: notifications report false, the rest of the capabilities stand
    }
    return {
      os: "macos",
      display: "cocoa",
      focus: issues.length > 0 ? "window" : "full",
      notify: probe.notify,
      notifyClick: probe.notifyClick,
      issues: [...issues, ...probe.issues],
    };
  }

  return {
    os: "macos",
    capabilities,
    resolveTarget: (origin, host) => discover.resolveTarget(origin, host),
    windowExists: (w) => discover.windowExists(w),
    foregroundWindow: () => discover.foregroundWindow(),
    listWindows: (names) => discover.listWindows(names),
    focus: (target, opts) => focus.focus(target, opts),
    async notify(n, onClick) {
      try {
        return await notifyBackend().notify(n, onClick);
      } catch {
        return null;
      }
    },
    async withdraw(h) {
      try {
        await notifyBackend().withdraw(h);
      } catch {
        // best effort
      }
    },
    async processAlive(pid, startTime) {
      try {
        return await processAliveRaw(pid, startTime);
      } catch {
        return false;
      }
    },
    async dispose() {
      try {
        await notifier?.dispose();
      } catch {
        // best effort
      }
    },
  };
}
