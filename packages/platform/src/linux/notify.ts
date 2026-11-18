import type { Capabilities, OsNotification } from "@mc/contracts";
import type { Exec } from "../exec.js";
import { layout } from "../layout.js";
import type { NotifyHandle, PlatformEnv } from "../types.js";

// dbus-next is loaded lazily (connectSessionBus) so importing this module on Windows or
// macOS never touches the D-Bus client. Hints are plain {signature, value} records here
// and become dbus-next Variants only at send time.

export interface HintVariant {
  signature: "y" | "s" | "b";
  value: number | string | boolean;
}

export interface NotifyOpts {
  replacesId: number;
  icon: string;
  sound: boolean;
  bodyMarkup: boolean;
}

/** The eight arguments of org.freedesktop.Notifications.Notify, in order (linux.md 5). */
export type NotifyArgs = [
  appName: string,
  replacesId: number,
  appIcon: string,
  summary: string,
  body: string,
  actions: string[],
  hints: Record<string, HintVariant>,
  expireTimeout: number,
];

const URGENCY_BYTE = { low: 0, normal: 1, critical: 2 } as const;
const ACTIONS = ["default", "Restore", "restore", "RESTORE"];

export function escapeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function notifyArgs(n: OsNotification, o: NotifyOpts): NotifyArgs {
  return [
    "Mission Control",
    o.replacesId,
    o.icon,
    n.title,
    o.bodyMarkup ? escapeMarkup(n.body) : n.body,
    ACTIONS,
    {
      urgency: { signature: "y", value: URGENCY_BYTE[n.urgency] },
      "desktop-entry": { signature: "s", value: "mission-control" },
      category: { signature: "s", value: "x-mission-control.attention" },
      "suppress-sound": { signature: "b", value: !o.sound },
    },
    -1,
  ];
}

/** The subset of a notification server connection this module uses. */
export interface NotifyConnection {
  capabilities(): Promise<string[]>;
  notify(args: NotifyArgs): Promise<number>;
  close(id: number): Promise<void>;
  onActionInvoked(cb: (id: number, key: string) => void): void;
  onClosed(cb: (id: number) => void): void;
  disconnect(): void;
}

/** Resolves to null when there is no session bus or no notification server on it. */
export type NotifyConnector = () => Promise<NotifyConnection | null>;

export interface NotifyAdapter {
  notify(
    n: OsNotification,
    onClick: (sessionId: string | null) => void,
  ): Promise<NotifyHandle | null>;
  withdraw(h: NotifyHandle): Promise<void>;
  probe(): Promise<{ notify: boolean; notifyClick: boolean; issues: Capabilities["issues"] }>;
  dispose(): Promise<void>;
}

const CALL_DEADLINE_MS = 1800;

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** The methods of the dbus-next proxy for org.freedesktop.Notifications. */
interface NotificationsProxy {
  GetCapabilities(): Promise<string[]>;
  Notify(...args: unknown[]): Promise<number>;
  CloseNotification(id: number): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export const connectSessionBus: NotifyConnector = async () => {
  let dbus: typeof import("dbus-next");
  try {
    dbus = await import("dbus-next");
  } catch {
    return null;
  }
  let bus: ReturnType<typeof dbus.sessionBus>;
  try {
    bus = dbus.sessionBus();
  } catch {
    return null;
  }
  try {
    const obj = await bus.getProxyObject(
      "org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
    );
    const raw = obj.getInterface("org.freedesktop.Notifications");
    if (!raw) {
      bus.disconnect();
      return null;
    }
    const iface = raw as unknown as NotificationsProxy;
    return {
      capabilities: () => iface.GetCapabilities(),
      notify: (args) => {
        const hints = Object.fromEntries(
          Object.entries(args[6]).map(([k, v]) => [k, new dbus.Variant(v.signature, v.value)]),
        );
        return iface.Notify(args[0], args[1], args[2], args[3], args[4], args[5], hints, args[7]);
      },
      close: (id) => iface.CloseNotification(id),
      onActionInvoked: (cb) => {
        iface.on("ActionInvoked", (...a: unknown[]) => cb(a[0] as number, a[1] as string));
      },
      onClosed: (cb) => {
        iface.on("NotificationClosed", (...a: unknown[]) => cb(a[0] as number));
      },
      disconnect: () => bus.disconnect(),
    };
  } catch {
    // ServiceUnknown (no notification server) or any other failure: no notifications.
    try {
      bus.disconnect();
    } catch {
      // already gone
    }
    return null;
  }
};

export function createNotify(deps: { exec: Exec; env: PlatformEnv }): NotifyAdapter {
  return createNotifyWithConnector(deps, connectSessionBus);
}

export function createNotifyWithConnector(
  deps: { exec: Exec; env: PlatformEnv },
  connect: NotifyConnector,
): NotifyAdapter {
  const icon = layout().iconPath;
  const tagToId = new Map<string, number>();
  const live = new Map<
    number,
    { tag: string; sessionId: string | null; onClick: (sessionId: string | null) => void }
  >();
  let caps: string[] = [];
  let disposed = false;

  const ready: Promise<NotifyConnection | null> = connect()
    .catch(() => null)
    .then(async (c) => {
      if (!c) return null;
      try {
        caps = await c.capabilities();
      } catch {
        c.disconnect();
        return null;
      }
      c.onActionInvoked((id, key) => {
        if (key !== "default" && key !== "restore") return;
        const entry = live.get(id);
        if (!entry) return;
        try {
          entry.onClick(entry.sessionId);
        } catch {
          // a throwing click handler must not break the bus
        }
      });
      c.onClosed((id) => {
        const entry = live.get(id);
        if (entry && tagToId.get(entry.tag) === id) tagToId.delete(entry.tag);
        live.delete(id);
      });
      return c;
    });

  function forget(id: number): void {
    const entry = live.get(id);
    if (entry && tagToId.get(entry.tag) === id) tagToId.delete(entry.tag);
    live.delete(id);
  }

  return {
    async notify(n, onClick) {
      if (disposed) return null;
      const c = await ready;
      if (!c) return null;
      const replacesId = tagToId.get(n.tag) ?? 0;
      const args = notifyArgs(n, {
        replacesId,
        icon,
        sound: n.urgency !== "low",
        bodyMarkup: caps.includes("body-markup"),
      });
      const id = await withDeadline(c.notify(args), CALL_DEADLINE_MS, 0);
      if (!id) return null;
      if (replacesId !== 0 && replacesId !== id) live.delete(replacesId);
      tagToId.set(n.tag, id);
      live.set(id, { tag: n.tag, sessionId: n.sessionId, onClick });
      return { id: String(id) };
    },

    async withdraw(h) {
      const id = Number(h.id);
      if (!Number.isInteger(id)) return;
      const c = await ready;
      if (c) await withDeadline(c.close(id), CALL_DEADLINE_MS, undefined);
      forget(id);
    },

    async probe() {
      const c = await ready;
      if (!c) {
        return {
          notify: false,
          notifyClick: false,
          issues: [
            {
              code: "linux_no_notification_server",
              severity: "warn",
              message: "No org.freedesktop.Notifications service on the session bus.",
              fix: "Every desktop ships one; on bare window managers install dunst or mako.",
            },
          ],
        };
      }
      return { notify: true, notifyClick: caps.includes("actions"), issues: [] };
    },

    async dispose() {
      disposed = true;
      const c = await ready;
      live.clear();
      tagToId.clear();
      c?.disconnect();
    },
  };
}
