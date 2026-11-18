# Contract: internal module interfaces

Status: FROZEN at plan freeze. These are the seams between tasks that run in parallel.
T001 writes every interface below verbatim into the named file, and creates every
module listed in section 4 as a stub that exports the frozen names and throws
`new Error("not implemented: <task id>")`. A builder replaces the stub body of the
files it owns and never changes an exported signature.

## 1. Daemon (`packages/daemon/src/internal.ts`)

```ts
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  Session, SessionId, IngestEnvelope, IngestOrigin, Host, FocusResult, Config,
  Capabilities, OsNotification, BridgeClientMessage, BridgeServerMessage,
} from "@mc/contracts";
import type { CoreEvent, SessionCursor } from "@mc/core";
import type { PlatformAdapter, ResolvedTarget, NativeWindow } from "@mc/platform";

export interface Clock { now(): number }                       // epoch ms; tests inject a fake
export interface Logger { info(o: object, msg?: string): void; warn(o: object, msg?: string): void; error(o: object, msg?: string): void }

export interface Paths {
  configDir: string; stateDir: string;
  configFile: string; tokenFile: string; daemonFile: string; sessionsFile: string;
  eventsFile: string; spoolDir: string; hookErrorsFile: string; logFile: string;
  fakePlatformFile: string; installManifestFile: string;
}

export interface ConfigStore {
  get(): Config;
  error(): string | null;                                       // last hot-reload error, null if ok
  onChange(cb: (c: Config) => void): () => void;
  close(): void;
}

export interface SessionRecord {
  session: Session;
  cursor: SessionCursor;
  origin: IngestOrigin | null;                                  // latest origin seen
  target: ResolvedTarget | null;                                // set by FocusService
}

export type SessionChange =
  | { type: "upsert"; prev: Session | undefined; next: Session; seq: number }
  | { type: "remove"; id: SessionId; seq: number };

export interface SessionService {
  /** Validate-free: the route already validated. Applies the reducer, persists, emits. */
  ingest(env: IngestEnvelope, receivedAt: number): { sessionId: SessionId };
  apply(ev: CoreEvent): Session | undefined;                    // ack, restore_result, process_exited, lost_timeout
  setRestore(id: SessionId, host: Host, restore: Session["restore"], target: ResolvedTarget | null): void;
  setGit(id: SessionId, project: string, branch: string | null): void;
  setTelemetry(id: SessionId, telemetry: Telemetry | null): void; // D-56; emits an upsert only when the value changed (deep compare)
  get(id: SessionId): SessionRecord | undefined;
  list(): Session[];                                            // sorted by startedAt ascending
  records(): SessionRecord[];
  remove(id: SessionId): boolean;
  seq(): number;                                                // service change counter; NOT the WS wire seq (D-27: ws.ts owns that)
  nextSeq(): number;                                            // increments and returns
  onChange(cb: (c: SessionChange) => void): () => void;
}

export interface PersistedState {
  version: 1; callsignCounter: number;
  records: SessionRecord[];
}
export interface Persistence {
  load(): Promise<PersistedState>;                              // missing/corrupt file -> empty state, corrupt file renamed *.corrupt-<ms>
  scheduleSave(get: () => PersistedState): void;                // debounced 500 ms
  flush(): Promise<void>;
  appendEvent(env: IngestEnvelope, receivedAt: number): void;   // events.jsonl with rotation
  readSpool(): Promise<{ file: string; envelope: unknown }[]>;  // sorted by file name
  deleteSpool(file: string): Promise<void>;
}

export interface BridgeWindow {
  windowId: string; extHostPid: number; workspaceName: string | null;
  workspaceFolders: string[]; remoteName: string | null;
  terminals: { terminalId: string; name: string; shellPid: number | null; active: boolean }[];
  nativeWindow: NativeWindow | null;
}
export interface BridgeRegistry {
  attach(socket: WebSocket): void;                              // takes over the socket (hello/terminals/windowState/result)
  windows(): BridgeWindow[];
  findForSession(origin: IngestOrigin, hostKind: Host["kind"]): { window: BridgeWindow; terminalId: string | null } | undefined;
  /** Adds a requestId, sends, resolves with the extension's result or {ok:false, detail:"timeout"} after 2000 ms. */
  request(windowId: string, msg:
    | { type: "focusTerminal"; terminalId: string; maximizePanel: boolean }
    | { type: "focusAgentPanel"; adapter: string }): Promise<{ ok: boolean; detail: string }>;
  rebind(windowId: string, w: NativeWindow | null): void;
  onChange(cb: () => void): () => void;
  close(): void;
}

export interface FocusService {
  /** Resolve (or refresh) the target for a session and write host/restore via SessionService.setRestore. */
  resolve(id: SessionId): Promise<void>;
  /** Full restore path; never throws. Applies a restore_result event. */
  restore(id: SessionId, source: "page" | "notification" | "cli"): Promise<FocusResult>;
}

export interface Notifier {
  start(): void;                                                // subscribes to SessionService.onChange, starts the 30 s renotify tick
  test(): Promise<{ sent: boolean; backend: string }>;
  stop(): void;
}

export interface Liveness { start(): void; stop(): void; checkNow(): Promise<void> }

export interface Auth {
  token(): string;
  issuePairCode(): { code: string; expiresAt: string };
  pair(code: string): { sessionCookie: string; csrf: string } | null;
  checkBearer(header: string | undefined): boolean;
  checkBrowser(cookie: string | undefined, csrf: string | undefined, method: string): boolean;
  /** HMAC-derived CSRF for a live browser session cookie (api.md 2), else null. */
  csrfFor(cookie: string | undefined): string | null;
  /** Write browser-sessions.json now if dirty (called on shutdown). */
  flush(): Promise<void>;
}

export interface CapabilitiesCache { get(): Promise<Capabilities>; invalidate(): void }

export interface DaemonDeps {
  clock: Clock; log: Logger; paths: Paths; config: ConfigStore; auth: Auth;
  sessions: SessionService; persistence: Persistence; bridges: BridgeRegistry;
  focus: FocusService; notifier: Notifier; liveness: Liveness; platform: PlatformAdapter;
  capabilities: CapabilitiesCache; version: string; startedAt: string;
  broadcast(msg: { type: "notify"; notification: OsNotification } | { type: "highlight"; sessionId: SessionId } | { type: "daemon.update" }): void;
}
```

## 2. Module factories (one per file, signatures frozen)

| File | Export | Owner |
|---|---|---|
| `packages/daemon/src/paths.ts` | `resolvePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Paths` | T014 |
| `packages/daemon/src/config.ts` | `loadConfig(paths: Paths, env: NodeJS.ProcessEnv): Promise<{ ok: true; store: ConfigStore } \| { ok: false; errors: string[] }>` | T014 |
| `packages/daemon/src/auth.ts` | `createAuth(paths: Paths, clock: Clock): Promise<Auth>` | T015 |
| `packages/daemon/src/security.ts` | `registerSecurity(app: FastifyInstance, opts: { port: () => number; auth: Auth; testMode: boolean }): void` and `type Realm = "none" \| "bearer" \| "browser" \| "browser-or-bearer"` plus route config `{ config: { realm: Realm, bodyLimit?: number } }` | T015 |
| `packages/daemon/src/persistence.ts` | `createPersistence(paths: Paths, clock: Clock, log: Logger): Persistence` | T016 |
| `packages/daemon/src/sessions.ts` | `createSessionService(opts: { clock: Clock; config: ConfigStore; persistence: Persistence; initial: PersistedState }): SessionService` | T021 |
| `packages/daemon/src/bridge.ts` | `createBridgeRegistry(opts: { clock: Clock; log: Logger; platform: PlatformAdapter }): BridgeRegistry` | T022 |
| `packages/daemon/src/notifier.ts` | `createNotifier(deps: Pick<DaemonDeps, "clock" \| "log" \| "config" \| "sessions" \| "platform" \| "focus" \| "broadcast">): Notifier` | T023 |
| `packages/daemon/src/focus.ts` | `createFocusService(deps: Pick<DaemonDeps, "clock" \| "log" \| "config" \| "sessions" \| "platform" \| "bridges">): FocusService` | T024 |
| `packages/daemon/src/liveness.ts` | `createLiveness(deps: Pick<DaemonDeps, "clock" \| "config" \| "sessions" \| "platform">): Liveness` | T025 |
| `packages/daemon/src/git.ts` | `readGit(cwd: string): Promise<{ project: string; branch: string \| null }>` | T025 |
| `packages/daemon/src/app.ts` | `buildApp(deps: DaemonDeps, opts: { uiDir: string \| null; testMode: boolean }): Promise<FastifyInstance>` | T026 |
| `packages/daemon/src/main.ts` | `startDaemon(opts: { env: NodeJS.ProcessEnv; foreground: boolean }): Promise<{ port: number; stop(): Promise<void> }>` | T027 |
| `packages/core/src/telemetry.ts` (D-56) | `createCopilotFold(): CopilotFold` with `CopilotFold { addEventLine(line: string): void; addOtelRecord(rec: unknown): void; snapshot(nowMs: number): Telemetry }`; pure, no I/O; `Telemetry` is the generated type from `session.schema.json` | T112 |
| `packages/core/src/claude-telemetry.ts` (D-61) | `createClaudeFold(): ClaudeFold` with `ClaudeFold { addLine(line: string, agent?: SubagentInfo): void; snapshot(nowMs: number): Telemetry; takeSpans(): SpanRecord[] }`; pure, no I/O; `SpanRecord` is the Copilot span shape `traces.ts` reads | T125 |
| `packages/daemon/src/telemetry.ts` (D-56) | `createTelemetry(deps: Pick<DaemonDeps, "clock" \| "log" \| "sessions" \| "paths">, opts: { copilotHome: string; claudeHome?: string; tickMs?: number }): { start(): void; stop(): void; tickNow(): Promise<void> }`; with `claudeHome`, also reads Claude Code transcripts (D-61) | T113, T125 |
| `packages/daemon/src/copilot-account.ts` (D-56) | `createCopilotAccount(deps: Pick<DaemonDeps, "clock" \| "log" \| "sessions">, opts: { client: CopilotAccountClient; refreshMs?: number; onChange(): void }): { start(): void; stop(): Promise<void>; current(): CopilotAccount \| null }`; `CopilotAccountClient` is the small interface over the SDK that tests fake | T114 |

## 3. UI (`packages/ui/src/`)

```ts
// packages/ui/src/model.ts  (T001 writes verbatim; types only)
import type { Session, StateResponse, FocusResult, Capabilities, DaemonInfo } from "@mc/contracts";
export type Link = "connecting" | "open" | "closed";
export interface BoardState {
  link: Link;
  needsPairing: boolean;
  state: StateResponse | null;
  results: Record<string, { result: FocusResult; until: number }>;   // by session id, shown 5 s
  pending: Record<string, true>;                                    // restore in flight
  highlight: string | null;                                         // session id from a highlight message
}
export interface BoardActions {
  restore(id: string): void;
  ack(id: string): void;
  dismiss(id: string): void;
  copyCwd(id: string): void;
  pair(code: string): Promise<boolean>;   // POST /api/pair, then reload state; false on 401
}
export interface CardProps { session: Session; now: number; result: FocusResult | null; pending: boolean; highlighted: boolean; actions: BoardActions }
export interface BarProps { hostname: string; now: number; link: Link; capabilities: Capabilities | null; daemon: DaemonInfo | null }
```

| File | Export | Owner |
|---|---|---|
| `packages/ui/src/main.tsx` | mounts `<App/>` into `#root`, imports fonts and css | T030 |
| `packages/ui/src/App.tsx` | `export function App(): JSX.Element` (uses `useBoard()`; renders Bar, Banner, PollStrip, Counts, Board) | T030 |
| `packages/ui/src/components/Bar.tsx` | `export function Bar(p: BarProps): JSX.Element` | T030 |
| `packages/ui/src/components/Banner.tsx` | `export function Banner(p: { board: BoardState; actions: BoardActions }): JSX.Element \| null` (the pairing banner holds the code entry form) | T030 |
| `packages/ui/src/components/Empty.tsx` | `export function Empty(): JSX.Element` | T030 |
| `packages/ui/src/components/Card.tsx` | `export function Card(p: CardProps): JSX.Element` | T031 |
| `packages/ui/src/components/Lamp.tsx` | `export function Lamp(p: { color: "tminus"\|"ascent"\|"go"\|"hold"\|"nogo"\|"los"; lit: boolean; glow?: boolean; size?: 8 \| 10; blink?: boolean }): JSX.Element` | T031 |
| `packages/ui/src/format.ts` | `stateLabel(s: Session): string`, `signalOf(s: Session): "tminus"\|"ascent"\|"go"\|"hold"\|"nogo"\|"los"`, `hostBadge(h: Session["host"]): string`, `hms(ms: number): string`, `age(ms: number): string`, `fixText(reason: string \| null, detail?: string): string` | T031 |
| `packages/ui/src/store.ts` | `export function useBoard(): { board: BoardState; actions: BoardActions }` | T032 |
| `packages/ui/src/api.ts` | `api: { state(): Promise<StateResponse \| "unpaired">; pair(code: string): Promise<boolean>; restore(id: string): Promise<FocusResult \| null>; ack(id: string): Promise<void>; dismiss(id: string): Promise<void> }` | T032 |
| `packages/ui/src/sort.ts` | `sortSessions(s: Session[]): { live: Session[]; splashdown: Session[] }`, `pollItems(s: Session[]): Session[]`, `counts(s: Session[]): { go: number; hold: number; nogo: number; los: number }` | T032 |
| `packages/ui/src/components/Board.tsx` | `export function Board(p: { board: BoardState; actions: BoardActions; now: number }): JSX.Element` (grid + SPLASHDOWN; renders `Card` and `Empty`) | T032 |
| `packages/ui/src/components/PollStrip.tsx` | `export function PollStrip(p: { sessions: Session[]; now: number; actions: BoardActions }): JSX.Element \| null` | T032 |
| `packages/ui/src/components/Counts.tsx` | `export function Counts(p: { sessions: Session[] }): JSX.Element` | T032 |

## 4. Stub list T001 creates

All files in the tables of sections 2 and 3, plus:
`packages/core/src/{index,attention,notify-policy,classify,callsign,summary}.ts`,
`packages/platform/src/index.ts` (T003 fills), `packages/platform/src/{windows,macos,linux}/index.ts`
(each `export async function create(env): Promise<PlatformAdapter>` stub),
`packages/platform/src/process/index.ts`
(`ancestry(fromPid: number): Promise<ProcessInfo[]>`, `processAlive(pid: number, startTime: string | null): Promise<boolean>`, `processStartTime(pid: number): Promise<string | null>`, `commandLine(pid: number): Promise<string | null>`, `ttyOf(pid: number): Promise<string | null>`),
`packages/hook/src/{main,claude,codex,shell,envelope,send,paths,mc-hook}.ts`, `packages/cli/src/mc.ts`,
`packages/platform/src/linux/dbus-service.ts` (`getDaemonService(): Promise<{ onReport(cb: (json: string) => void): () => void }>`, T046),
`packages/cli/src/{main,commands/*}.ts` (section 7), `packages/platform/src/exec.ts` and `packages/platform/src/<os>/{discover,focus,notify}.ts` (section 6),
`packages/vscode-bridge/src/extension.ts`.

`packages/core/src/index.ts` re-exports: `reduce`, `ReducerOptions`, `CoreEvent`,
`SessionCursor` (attention.ts); `decide`, `decideRenotify`, `Coalescer`,
`NotifyContext`, `NotifyDecision` (notify-policy.ts); `classifyHost`, `VSCODE_NAMES`, `SHELL_NAMES`, `LINUX_TERMINALS` (classify.ts);
`CallsignAllocator` (`class { constructor(counter: number, inUse: () => Set<string>); next(): string; counter(): number }`, callsign.ts);
`summarize(adapter, event, payload): string` (summary.ts).

## 5. (reserved)

Kept empty so that "section 6" references in task files stay valid.

## 6. Platform OS modules (`packages/platform/src/<os>/`)

So that the discover, focus and notify tasks of one OS can run in parallel, each OS
directory has the same four files with these frozen exports (`Exec` is the shared
child-process helper in `packages/platform/src/exec.ts`, written by T003):

```ts
// exec.ts (T003)
export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string }) => Promise<ExecResult>;
export const exec: Exec;                 // spawn without a shell, windowsHide, default timeout 3000 ms, kill on timeout
export function which(cmd: string): Promise<string | null>;
export const semaphore: { run<T>(f: () => Promise<T>): Promise<T> };   // max 4 concurrent helpers

// <os>/discover.ts (T040 / T043 / T045)
export interface Discover {
  resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget>;
  windowExists(w: NativeWindow): Promise<boolean>;
  foregroundWindow(): Promise<NativeWindow | null>;
  listWindows(appNames: string[]): Promise<NativeWindow[]>;
}
export function createDiscover(deps: { exec: Exec; env: PlatformEnv }): Discover;

// <os>/focus.ts (T041 / T043 / T045)
export function createFocus(deps: { exec: Exec; env: PlatformEnv; discover: Discover }): {
  focus(target: ResolvedTarget, opts: FocusOptions): Promise<FocusResult>;
};

// <os>/notify.ts (T042 / T044 / T046)
export function createNotify(deps: { exec: Exec; env: PlatformEnv }): {
  notify(n: OsNotification, onClick: (sessionId: string | null) => void): Promise<NotifyHandle | null>;
  withdraw(h: NotifyHandle): Promise<void>;
  probe(): Promise<{ notify: boolean; notifyClick: boolean; issues: Capabilities["issues"] }>;
  dispose(): Promise<void>;
};

// <os>/index.ts (owned by the discover task of that OS)
export async function create(env: PlatformEnv): Promise<PlatformAdapter>;   // composes the three + process utils + capabilities()

// types.ts (T003) also exports:
export interface PlatformEnv { stateDir: string; config: Config; repoRoot: string; displayEnv(): NodeJS.ProcessEnv }
```

`displayEnv()` returns `process.env` overlaid with the display variables of the latest
envelope (`linux.md` 1); the daemon supplies it. On Windows, `koffi` bindings live in
`packages/platform/src/windows/win32.ts`, owned by T040; T041 and T042 add the
functions they need to their own files (`focus.ts`, `notify.ts`) by declaring them
locally with `koffi.load("user32.dll").func(...)`, never by editing `win32.ts`.

## 7. CLI commands (`packages/cli/src/commands/<name>.ts`, each `export async function run(argv: string[], io: Io): Promise<number>`)

`Io = { out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv; cwd: string }`.
`main.ts` dispatches `mc <name> ...` to the file of that name. Names and owners:
`start`, `stop`, `status`, `daemon` (foreground), `open`, `restore`, `token`, `doctor`
(T050); `install`, `uninstall` (T051). Exit codes: 0 ok, 1 failure, 2 usage/config.
