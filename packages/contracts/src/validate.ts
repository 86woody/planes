import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats is CJS: under NodeNext the default import is the module namespace, so take .default.
const addFormats = addFormatsModule.default;
import type { Config } from "./index.js";
import type { IngestEnvelope } from "./generated/ingest.js";
import type { Session } from "./generated/session.js";
import type { BridgeClientMessage, BridgeServerMessage } from "./generated/bridge.js";
import type { TracesResponse, WsServerMessage } from "./generated/api.js";

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const BASE = "https://mission-control.local/contracts/";
const FILES = ["session", "ingest", "api", "config", "bridge"] as const;

const sources: object[] = FILES.map(
  (f) => JSON.parse(readFileSync(path.join(SCHEMA_DIR, `${f}.schema.json`), "utf8")) as object,
);

function makeAjv(useDefaults: boolean): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults });
  addFormats(ajv);
  for (const s of sources) ajv.addSchema(s);
  return ajv;
}

function must(ajv: Ajv2020, ref: string): ValidateFunction {
  const v = ajv.getSchema(BASE + ref);
  if (!v) throw new Error(`schema not registered: ${ref}`);
  return v;
}

function errorStrings(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
}

const plain = makeAjv(false);
const withDefaults = makeAjv(true);

const vSession = must(plain, "session.schema.json");
const vEnvelope = must(plain, "ingest.schema.json");
const vConfig = must(withDefaults, "config.schema.json");
const vWsServer = must(plain, "api.schema.json#/$defs/WsServerMessage");
const vTraces = must(plain, "api.schema.json#/$defs/TracesResponse");
const vBridgeClient = must(plain, "bridge.schema.json#/$defs/BridgeClientMessage");
const vBridgeServer = must(plain, "bridge.schema.json#/$defs/BridgeServerMessage");

function run<T>(v: ValidateFunction, x: unknown): Validated<T> {
  if (v(x)) return { ok: true, value: x as T };
  return { ok: false, errors: errorStrings(v.errors) };
}

export function validateSession(x: unknown): Validated<Session> {
  return run<Session>(vSession, x);
}

export function validateEnvelope(x: unknown): Validated<IngestEnvelope> {
  return run<IngestEnvelope>(vEnvelope, x);
}

// Uses a separate instance with useDefaults; works on a copy so the caller's object is untouched.
export function validateConfig(x: unknown): Validated<Config> {
  const copy: unknown = typeof x === "object" && x !== null ? structuredClone(x) : x;
  return run<Config>(vConfig, copy);
}

export function validateWsServerMessage(x: unknown): Validated<WsServerMessage> {
  return run<WsServerMessage>(vWsServer, x);
}

/** D-57. */
export function validateTracesResponse(x: unknown): Validated<TracesResponse> {
  return run<TracesResponse>(vTraces, x);
}

export function validateBridgeClientMessage(x: unknown): Validated<BridgeClientMessage> {
  return run<BridgeClientMessage>(vBridgeClient, x);
}

export function validateBridgeServerMessage(x: unknown): Validated<BridgeServerMessage> {
  return run<BridgeServerMessage>(vBridgeServer, x);
}
