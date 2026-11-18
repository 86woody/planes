# Contract: the platform adapter

Status: FROZEN at plan freeze. T003 writes this interface verbatim to
`packages/platform/src/types.ts` and the conformance suite to
`packages/platform/test/conformance.ts`. Implementations: `windows/` (T040-T042),
`macos/` (T043-T044), `linux/` (T045-T046), `fake/` (T003).

## 1. Interface

```ts
import type { Host, FocusResult, Capabilities, OsNotification, IngestOrigin } from "@mc/contracts";

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
```

`IngestOrigin` is the generated type for `ingest.schema.json#/$defs/Origin`. `Config`
from `config.schema.json`. All types are exported from `@mc/contracts`.

## 2. Selection

`packages/platform/src/index.ts` exports `createPlatform(env)`: `MC_PLATFORM=fake` ->
fake; else by `process.platform`: `win32` -> windows, `darwin` -> macos, `linux` ->
linux; anything else -> a `NullPlatform` (capabilities focus `none`, notify false;
every focus `unsupported`; `resolveTarget` -> `{window: null, inner: null, capability:
"none", reason: "no_window_found"}` (D-23); the explanation lives in the capabilities
issue `platform_unsupported`).

## 3. Behavioural rules every implementation obeys

| ID | Rule |
|---|---|
| PA-01 | No method throws or rejects. Internal errors become `FocusResult{status: failed, code: error}`, `null`, or `false`. |
| PA-02 | `focus` on a target with `capability: none` returns `{failed, unsupported, detail: <reason>}` without side effects. |
| PA-03 | `focus` returns `ok/focused` only if, after acting, `foregroundWindow()` equals the target window (verified, not assumed); if the window is foreground but the inner selector failed: `partial/focused_window_only`; if foreground could not be taken but the window was flashed/requested attention: `partial/flashed`. |
| PA-04 | `focus` on a window that no longer exists returns `{failed, not_found}`. |
| PA-05 | Every child process has a timeout (3000 ms default) and is killed on timeout -> `{failed, timeout}`. |
| PA-06 | `maximize: always` maximizes even if the window is already restored and visible; `if-minimized` maximizes only if it was minimized; `never` only restores. |
| PA-07 | `notify` never blocks longer than 2000 ms, except the first call after the adapter starts a long-lived helper process (Windows toast host, windows.md 5.2), which may take up to 6000 ms. |
| PA-08 | `resolveTarget` and `foregroundWindow` never change window state. |
| PA-09 | `processAlive(pid, null)` is a plain existence check; with a startTime it is false if the start time differs. |

The conformance suite (`conformance.ts`) exports
`runConformance(name: string, make: () => Promise<PlatformAdapter>, fixtures: ConformanceFixtures)`
which checks PA-01, PA-02, PA-04, PA-07 and PA-09 against any adapter (PA-05 needs an
injected slow `Exec`, so each OS task tests it in its own unit file instead); OS test files call it with a real adapter under
`MC_OS_TESTS=1`, the fake calls it always.

## 4. Errors to `RestoreReason` mapping (resolveTarget)

| Situation | capability | reason |
|---|---|---|
| `host.kind == remote` | none | `remote_session` |
| no window found by any method | none | `no_window_found` |
| Wayland compositor without a backend | none | `wayland_unsupported_compositor` |
| GNOME Wayland, extension D-Bus name absent | none | `gnome_extension_missing` |
| macOS Accessibility not granted (needed for non-scriptable apps and zoom) | window or none | `macos_accessibility_denied` |
| macOS Automation denied for Terminal/iTerm2 | window | `macos_automation_denied` |
| window found, tab cannot be addressed (GNOME Terminal tabs, Konsole tabs, WT tab title ambiguous) | window | `tab_not_addressable` |
| tmux pane known but no attached client | window or none | `multiplexer_detached` |

VS Code targets are resolved by the daemon (ARCHITECTURE.md 4), which uses
`vscode_bridge_missing` and `vscode_window_unbound`.

## 5. Fake platform

`FakePlatform` (T003) implements the interface with scripted behaviour:

```ts
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
export class FakePlatform implements PlatformAdapter {
  constructor(script?: FakeScript, log?: (c: FakeCall) => void);
  calls: FakeCall[];
  setScript(patch: Partial<FakeScript>): void;
}
```

When the daemon runs with `MC_PLATFORM=fake`, it appends every `FakeCall` as a JSON
line to `<stateDir>/fake-platform.jsonl` and serves them at
`GET /api/test/fake-platform` (api.md 3, guarded by `MC_TEST=1`).
