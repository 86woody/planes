// The daemon's own D-Bus service (linux.md 3.3): org.missioncontrol.Daemon at "/" with
// Report(s). The KWin backend calls Report from its script. dbus-next is loaded lazily.

export const DAEMON_NAME = "org.missioncontrol.Daemon";
export const DAEMON_PATH = "/";

export interface DaemonService {
  onReport(cb: (json: string) => void): () => void;
}

/** Exports the Report method on the session bus and requests the well-known name. */
export interface DaemonBus {
  exportDaemon(report: (json: string) => void): Promise<boolean>;
}

/** Resolves to null when there is no session bus. */
export type DaemonConnector = () => Promise<DaemonBus | null>;

export async function createDaemonService(connect: DaemonConnector): Promise<DaemonService> {
  const listeners = new Set<(json: string) => void>();
  const report = (json: string): void => {
    for (const cb of [...listeners]) {
      try {
        cb(json);
      } catch {
        // one failing listener must not affect the others or the bus
      }
    }
  };
  try {
    const bus = await connect();
    if (bus) await bus.exportDaemon(report).catch(() => false);
  } catch {
    // no bus: the service is a no-op and callbacks never fire
  }
  return {
    onReport(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

export const connectSessionBus: DaemonConnector = async () => {
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
  return {
    async exportDaemon(report) {
      class DaemonInterface extends dbus.interface.Interface {
        Report(json: string): void {
          report(json);
        }
      }
      DaemonInterface.configureMembers({
        methods: { Report: { inSignature: "s", outSignature: "" } },
      });
      try {
        bus.export(DAEMON_PATH, new DaemonInterface(DAEMON_NAME));
        const reply = await bus.requestName(DAEMON_NAME, 0);
        // D-Bus RequestName reply codes: 1 primary owner, 4 already owner.
        const owned = reply === 1 || reply === 4;
        if (!owned) bus.disconnect();
        return owned;
      } catch {
        bus.disconnect();
        return false;
      }
    },
  };
};

let cached: Promise<DaemonService> | null = null;

export function getDaemonService(): Promise<DaemonService> {
  cached ??= createDaemonService(connectSessionBus);
  return cached;
}
