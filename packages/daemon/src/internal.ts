/* eslint-disable @typescript-eslint/no-unused-vars -- imports are verbatim from internal.md section 1 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  Session, SessionId, IngestEnvelope, IngestOrigin, Host, FocusResult, Config, Telemetry,
  Capabilities, OsNotification, BridgeClientMessage, BridgeServerMessage, CopilotAccount,
} from "@mc/contracts";
import type { CoreEvent, SessionCursor } from "@mc/core";
import type { PlatformAdapter, ResolvedTarget, NativeWindow } from "@mc/platform";
import type { TraceStore } from "./traces.js";

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
  copilot: { current(): CopilotAccount | null }; // D-56 (T114)
  traces: TraceStore; // D-57 (T117)
  broadcast(msg: { type: "notify"; notification: OsNotification } | { type: "highlight"; sessionId: SessionId } | { type: "daemon.update" }): void;
}
