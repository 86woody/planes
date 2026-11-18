import type { Capabilities, FocusResult, Host, IngestOrigin, OsNotification } from "@mc/contracts";
import type {
  FocusOptions,
  NativeWindow,
  NotifyHandle,
  PlatformAdapter,
  ResolvedTarget,
} from "./types.js";

/** Used on operating systems without a backend. Every focus is unsupported; nothing is shown. */
export class NullPlatform implements PlatformAdapter {
  readonly os: "windows" | "macos" | "linux";

  constructor(os: "windows" | "macos" | "linux" = "linux") {
    this.os = os;
  }

  async capabilities(): Promise<Capabilities> {
    return {
      os: this.os,
      display: null,
      focus: "none",
      notify: false,
      notifyClick: false,
      issues: [
        {
          code: "platform_unsupported",
          severity: "warn",
          message: "This operating system has no window backend.",
          fix: "Restore and notifications are unavailable on this machine.",
        },
      ],
    };
  }

  async resolveTarget(_origin: IngestOrigin, _host: Host): Promise<ResolvedTarget> {
    return { window: null, inner: null, capability: "none", reason: "no_window_found" };
  }

  async windowExists(_w: NativeWindow): Promise<boolean> {
    return false;
  }

  async foregroundWindow(): Promise<NativeWindow | null> {
    return null;
  }

  async listWindows(_appNames: string[]): Promise<NativeWindow[]> {
    return [];
  }

  async focus(target: ResolvedTarget, _opts: FocusOptions): Promise<FocusResult> {
    return {
      status: "failed",
      code: "unsupported",
      detail: target.reason ?? "platform_unsupported",
      at: new Date().toISOString(),
    };
  }

  async notify(
    _n: OsNotification,
    _onClick: (sessionId: string | null) => void,
  ): Promise<NotifyHandle | null> {
    return null;
  }

  async withdraw(_h: NotifyHandle): Promise<void> {}

  /** Plain existence check. With a start time it cannot be verified here, so it is false. */
  async processAlive(pid: number, startTime: string | null): Promise<boolean> {
    if (startTime !== null || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  async dispose(): Promise<void> {}
}
