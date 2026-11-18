import type {
  Capabilities, FocusResult, Host, IngestOrigin, OsNotification,
} from "@mc/contracts";
import type {
  FakeCall, FakeScript, FocusOptions, NativeWindow, NotifyHandle, PlatformAdapter, ResolvedTarget,
} from "../types.js";

type Os = NativeWindow["os"];

const STATUS_FOR: Record<FocusResult["code"], FocusResult["status"]> = {
  focused: "ok",
  focused_window_only: "partial",
  flashed: "partial",
  not_found: "failed",
  unsupported: "failed",
  permission_denied: "failed",
  timeout: "failed",
  rate_limited: "failed",
  error: "failed",
};

/** Scripted platform for tests and for the daemon under MC_PLATFORM=fake (platform-adapter.md 5). */
export class FakePlatform implements PlatformAdapter {
  readonly os: Os = "linux";
  calls: FakeCall[] = [];
  private script: FakeScript;
  private readonly log: ((c: FakeCall) => void) | undefined;
  private lastOnClick: ((sessionId: string | null) => void) | null = null;
  private notifyCount = 0;

  constructor(script: FakeScript = {}, log?: (c: FakeCall) => void) {
    this.script = { ...script };
    this.log = log;
  }

  setScript(patch: Partial<FakeScript>): void {
    this.script = { ...this.script, ...patch };
  }

  /** Invokes the onClick stored by the most recent notify(). Not recorded in calls. */
  click(sessionId: string | null): void {
    this.lastOnClick?.(sessionId);
  }

  private record(method: FakeCall["method"], args: unknown): void {
    const c: FakeCall = { at: Date.now(), method, args };
    this.calls.push(c);
    this.log?.(c);
  }

  private async delay(): Promise<void> {
    const ms = this.script.delayMs ?? 0;
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private isDead(handle: string): boolean {
    return this.script.deadHandles?.has(handle) ?? false;
  }

  async capabilities(): Promise<Capabilities> {
    this.record("capabilities", []);
    await this.delay();
    return this.script.capabilities ?? {
      os: this.os, display: null, focus: "full", notify: true, notifyClick: true, issues: [],
    };
  }

  async resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget> {
    this.record("resolveTarget", [origin, host]);
    await this.delay();
    if (this.script.resolve) return this.script.resolve(origin, host);
    const pid = origin.agent?.pid ?? 0;
    return {
      window: { os: origin.os, handle: "0xFAKE" + pid, pid, app: "FakeTerm", title: "fake" },
      inner: null,
      capability: "full",
      reason: null,
    };
  }

  async windowExists(w: NativeWindow): Promise<boolean> {
    this.record("windowExists", [w]);
    await this.delay();
    return !this.isDead(w.handle);
  }

  async foregroundWindow(): Promise<NativeWindow | null> {
    this.record("foregroundWindow", []);
    await this.delay();
    const h = this.script.foregroundSessionWindow;
    if (h === undefined || h === null) return null;
    return { os: this.os, handle: h, pid: 0, app: "FakeTerm", title: "fake" };
  }

  async listWindows(appNames: string[]): Promise<NativeWindow[]> {
    this.record("listWindows", [appNames]);
    await this.delay();
    return [];
  }

  async focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult> {
    this.record("focus", [target, opts]);
    await this.delay();
    const at = new Date(Date.now()).toISOString();
    if (target.capability === "none") {
      return { status: "failed", code: "unsupported", detail: target.reason ?? "fake", at };
    }
    if (target.window === null || this.isDead(target.window.handle)) {
      return { status: "failed", code: "not_found", detail: "fake", at };
    }
    const code = this.script.focusResult ?? "focused";
    return { status: STATUS_FOR[code], code, detail: "fake", at };
  }

  async notify(n: OsNotification, onClick: (sessionId: string | null) => void): Promise<NotifyHandle | null> {
    this.record("notify", [n]);
    await this.delay();
    this.lastOnClick = onClick;
    this.notifyCount += 1;
    return { id: `fake-${this.notifyCount}` };
  }

  async withdraw(h: NotifyHandle): Promise<void> {
    this.record("withdraw", [h]);
    await this.delay();
  }

  async processAlive(pid: number, startTime: string | null): Promise<boolean> {
    this.record("processAlive", [pid, startTime]);
    await this.delay();
    const alive = this.script.alivePids ?? "all";
    if (alive !== "all" && !alive.has(pid)) return false;
    const scripted = this.script.startTimes?.[pid];
    if (startTime !== null && scripted !== undefined && scripted !== startTime) return false;
    return true;
  }

  async dispose(): Promise<void> {
    this.record("dispose", []);
    await this.delay();
  }
}
