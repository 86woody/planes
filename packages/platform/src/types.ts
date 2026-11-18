import type {
  Host, FocusResult, Capabilities, OsNotification, IngestOrigin, RestoreReason, Config,
} from "@mc/contracts";

/** Opaque to everything outside the platform package. JSON-serialisable (persisted in sessions.json). */
export interface NativeWindow {
  os: "windows" | "macos" | "linux";
  /** windows: HWND as "0x" + 16 hex; macos: "<pid>:<axWindowIndex or title hash>"; x11: "0x" window id; wayland: compositor id as string */
  handle: string;
  /** Process that owns the window. */
  pid: number;
  /** Owning app, e.g. "WindowsTerminal.exe", "Terminal", "iTerm2", "kitty". */
  app: string;
  /** Title at resolution time, used for re-resolution if the handle goes stale. */
  title: string;
}

/** What to select inside the window. At most one field is set. */
export interface InnerSelector {
  tty?: string;              // Terminal.app / iTerm2 tab by tty
  wtTabTitle?: string;       // Windows Terminal tab by title (UI Automation)
  tmuxPane?: string;         // "%12"
  kittyWindowId?: string;
  weztermPane?: string;
}

export interface ResolvedTarget {
  window: NativeWindow | null;
  inner: InnerSelector | null;
  capability: "full" | "window" | "none";
  reason: RestoreReason | null;   // from session.schema.json
}

export interface FocusOptions {
  maximize: "always" | "if-minimized" | "never";
  /** Windows only: use the ALT-key foreground workaround (config restore.windowsForegroundStrategy). */
  foregroundStrategy: "alt-key" | "plain";
  /** True when invoked from a notification click (the process may own foreground rights). */
  fromActivation: boolean;
}

export interface NotifyHandle { id: string }

export interface PlatformAdapter {
  readonly os: "windows" | "macos" | "linux";

  /** Static and permission checks; cheap; cached by the daemon for 60 s. */
  capabilities(): Promise<Capabilities>;

  /** Map an ingest origin (+ host classification) to a window and inner selector. Must not focus anything. <= 1500 ms. */
  resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget>;

  /** True if the window still exists (handle valid and owned by the same pid). */
  windowExists(w: NativeWindow): Promise<boolean>;

  /** The current foreground window, or null if unknown/unsupported. */
  foregroundWindow(): Promise<NativeWindow | null>;

  /** Visible top-level windows whose owning process name (lower-cased, ".exe" stripped) is in appNames.
   * Used for the VS Code title fallback (vscode-bridge.md 5). [] if unsupported. Never changes window state. */
  listWindows(appNames: string[]): Promise<NativeWindow[]>;

  /** Restore, maximize (per options), raise, select inner. Never throws; all failures are FocusResult. <= 3000 ms. */
  focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult>;

  /** Show an OS notification. onClick fires (in-process) if the backend can deliver clicks to the daemon;
   * otherwise clicks arrive through the URI handler (mc restore). Never throws; returns null if not shown. */
  notify(n: OsNotification, onClick: (sessionId: string | null) => void): Promise<NotifyHandle | null>;

  /** Remove a shown notification if the backend supports it (best effort). */
  withdraw(h: NotifyHandle): Promise<void>;

  /** PID alive and, when startTime is given, the same process (PID reuse safe). */
  processAlive(pid: number, startTime: string | null): Promise<boolean>;

  /** Release helpers, D-Bus connections, timers. */
  dispose(): Promise<void>;
}

export interface PlatformEnv { stateDir: string; config: Config; repoRoot: string; displayEnv(): NodeJS.ProcessEnv }
export type PlatformFactory = (env: PlatformEnv) => Promise<PlatformAdapter>;

// platform-adapter.md 5 (FakePlatform types; the class lives in fake/index.ts)
export interface FakeCall {
  at: number;
  method: "capabilities" | "resolveTarget" | "windowExists" | "foregroundWindow" | "listWindows"
        | "focus" | "notify" | "withdraw" | "processAlive" | "dispose";   // every PlatformAdapter method (D-23); setScript and click are not recorded
  args: unknown;   // the method's arguments as an array, e.g. [origin, host]; onClick callbacks are omitted
}
export interface FakeScript {
  capabilities?: Capabilities;
  resolve?: (origin: IngestOrigin, host: Host) => ResolvedTarget;   // default: window {handle: "0xFAKE" + pid}, capability full
  focusResult?: FocusResult["code"];                                // default "focused"
  foregroundSessionWindow?: string | null;                          // handle reported by foregroundWindow()
  alivePids?: Set<number> | "all";                                  // default "all"
  startTimes?: Record<number, string>;  // processAlive(pid, st) is false when startTimes[pid] is set and differs from st
  deadHandles?: Set<string>;            // windowExists false, and focus returns failed/not_found, for these handles
  delayMs?: number;                                                 // added to every call (PA-05 tests)
}
