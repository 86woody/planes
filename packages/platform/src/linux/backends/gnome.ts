import dbus from "dbus-next";
import type { FocusOptions } from "../../types.js";
import { focusResult, pollUntil, type LinuxBackend, type LinuxWindow } from "./select.js";

const DEST = "org.gnome.Shell";
const PATH = "/org/gnome/Shell/Extensions/Windows";
const IFACE = "org.gnome.Shell.Extensions.Windows";

/** The three methods of the "Window Calls" extension (linux.md 3.4). */
export interface WindowCallsClient {
  list(): Promise<string>;
  unminimize(id: number): Promise<void>;
  activate(id: number): Promise<void>;
  maximize(id: number): Promise<void>;
  close(): void;
}

/** Typed view of the extension interface; dbus-next types methods only as an index signature. */
interface WcIface {
  List(): Promise<unknown>;
  Unminimize(id: number): Promise<unknown>;
  Activate(id: number): Promise<unknown>;
  Maximize(id: number): Promise<unknown>;
}

interface WcWindow {
  id?: number | string;
  pid?: number;
  title?: string;
  wm_class?: string;
  focus?: boolean;
  minimized?: boolean;
  fullscreen?: boolean;
}

/** `List()` JSON: [{id, pid, title, wm_class, focus, ...}]. */
export function parseWindowCalls(json: string): Array<LinuxWindow & { focus: boolean }> {
  const arr = JSON.parse(json) as WcWindow[];
  const out: Array<LinuxWindow & { focus: boolean }> = [];
  for (const c of arr) {
    if (c.id === undefined || typeof c.pid !== "number") continue;
    out.push({
      id: String(c.id),
      pid: c.pid,
      title: c.title ?? "",
      app: (c.wm_class ?? "").toLowerCase(),
      stackIndex: out.length,
      minimized: c.minimized === true,
      fullscreen: c.fullscreen === true ? 1 : 0,
      focus: c.focus === true,
    });
  }
  return out;
}

/** Production client over the session bus; the connection opens on first use. */
export function dbusWindowCalls(): () => Promise<WindowCallsClient> {
  let pending: Promise<WindowCallsClient> | null = null;
  return () => {
    if (pending === null) {
      pending = (async (): Promise<WindowCallsClient> => {
        const bus = dbus.sessionBus();
        const obj = await bus.getProxyObject(DEST, PATH);
        const iface = obj.getInterface(IFACE) as unknown as WcIface;
        return {
          list: async () => String(await iface.List()),
          unminimize: async (id) => {
            await iface.Unminimize(id);
          },
          activate: async (id) => {
            await iface.Activate(id);
          },
          maximize: async (id) => {
            await iface.Maximize(id);
          },
          close: () => bus.disconnect(),
        };
      })();
    }
    return pending;
  };
}

export function createGnome(deps: { client?: () => Promise<WindowCallsClient> } = {}): LinuxBackend & {
  available(): Promise<boolean>;
  dispose(): void;
} {
  const client = deps.client ?? dbusWindowCalls();

  async function list(): Promise<Array<LinuxWindow & { focus: boolean }>> {
    try {
      return parseWindowCalls(await (await client()).list());
    } catch {
      return [];
    }
  }

  async function active(): Promise<LinuxWindow | null> {
    return (await list()).find((w) => w.focus) ?? null;
  }

  return {
    async available() {
      try {
        await (await client()).list();
        return true;
      } catch {
        return false;
      }
    },

    list,

    active,

    async focus(w: LinuxWindow, opts: FocusOptions) {
      const c = await client();
      const id = Number(w.id);
      const wasMinimized = w.minimized === true;
      if (wasMinimized) await c.unminimize(id);
      await c.activate(id);
      const wantMaximize = opts.maximize === "always" || (opts.maximize === "if-minimized" && wasMinimized);
      if (wantMaximize) await c.maximize(id);
      // GNOME may ignore Activate (focus-stealing prevention): not focused within 500 ms is flashed.
      if (await pollUntil(async () => (await active())?.id === w.id)) return focusResult("focused");
      return focusResult("flashed", "GNOME focus-stealing prevention; window flashed");
    },

    dispose() {
      void client().then((c) => c.close(), () => {});
    },
  };
}
