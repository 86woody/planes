import type { Config as GeneratedConfig } from "./generated/config.js";

export type {
  Adapter,
  Attention,
  AttentionReason,
  FocusResult,
  Host,
  HostKind,
  Instant,
  RestoreReason,
  Session,
  SessionId,
  State,
  Telemetry,
} from "./generated/session.js";
export type { IngestEnvelope, Origin as IngestOrigin, ProcessInfo } from "./generated/ingest.js";
export type {
  Capabilities,
  CopilotAccount,
  DaemonInfo,
  Error,
  Health,
  OsNotification,
  PairCodeResponse,
  PairRequest,
  PairResponse,
  RestoreResponse,
  SessionResponse,
  StateResponse,
  TraceRun,
  TraceSpan,
  TracesResponse,
  WsClientMessage,
  WsServerMessage,
} from "./generated/api.js";
export type {
  BridgeClientMessage,
  BridgeFocusAgentPanel,
  BridgeFocusTerminal,
  BridgeHello,
  BridgeResult,
  BridgeServerMessage,
  BridgeTerminalInfo,
  BridgeTerminals,
  BridgeWelcome,
  BridgeWindowState,
} from "./generated/bridge.js";

export type { Validated } from "./validate.js";
export {
  validateBridgeClientMessage,
  validateBridgeServerMessage,
  validateConfig,
  validateEnvelope,
  validateSession,
  validateTracesResponse,
  validateWsServerMessage,
} from "./validate.js";

// The file as written: every property optional, defaults not applied.
export type ConfigFile = GeneratedConfig;

type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T;

// The resolved config: every property present (defaults applied by validateConfig).
export type Config = DeepRequired<GeneratedConfig>;
