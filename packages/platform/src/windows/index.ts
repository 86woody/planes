import type { PlatformAdapter, PlatformEnv } from "../types.js";
import { exec } from "../exec.js";
import { processAlive as processAliveImpl } from "../process/index.js";
import { createDiscover } from "./discover.js";
import { createFocus } from "./focus.js";
import { createNotify } from "./notify.js";

/** Windows PlatformAdapter: discover (T040) + focus (T041) + notify (T042). PA-01: nothing throws. */
export async function create(env: PlatformEnv): Promise<PlatformAdapter> {
  const discover = createDiscover({ exec, env });
  const focus = createFocus({ exec, env, discover });
  const notify = createNotify({ exec, env });

  return {
    os: "windows",

    async capabilities() {
      try {
        return { os: "windows", display: "win32", focus: "full", ...(await notify.probe()) } as Awaited<
          ReturnType<PlatformAdapter["capabilities"]>
        >;
      } catch {
        return { os: "windows", display: "win32", focus: "full", notify: false, notifyClick: false, issues: [] } as Awaited<
          ReturnType<PlatformAdapter["capabilities"]>
        >;
      }
    },

    async resolveTarget(origin, host) {
      try {
        return await discover.resolveTarget(origin, host);
      } catch {
        return { window: null, inner: null, capability: "none", reason: "platform_error" };
      }
    },

    async windowExists(w) {
      try {
        return await discover.windowExists(w);
      } catch {
        return false;
      }
    },

    async foregroundWindow() {
      try {
        return await discover.foregroundWindow();
      } catch {
        return null;
      }
    },

    async listWindows(appNames) {
      try {
        return await discover.listWindows(appNames);
      } catch {
        return [];
      }
    },

    async focus(target, opts) {
      try {
        return await focus.focus(target, opts);
      } catch {
        return { status: "failed", code: "error", detail: "focus threw" } as Awaited<ReturnType<typeof focus.focus>>;
      }
    },

    async notify(n, onClick) {
      try {
        return await notify.notify(n, onClick);
      } catch {
        return null;
      }
    },

    async withdraw(h) {
      try {
        await notify.withdraw(h);
      } catch {
        // best effort
      }
    },

    async processAlive(pid, startTime) {
      try {
        return await processAliveImpl(pid, startTime);
      } catch {
        return false;
      }
    },

    async dispose() {
      try {
        await notify.dispose();
      } catch {
        // best effort
      }
    },
  };
}
