// ingest.md section 1 (transport and outcomes) and D-11 (spool). Never throws.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IngestEnvelope } from "@mc/contracts";
import type { Paths } from "./paths.js";

const DEFAULT_PORT = 47800;
const MAX_SPOOL = 1000;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536;

/** daemon.json (running daemon), then config.json, then 47800. */
export function readPort(paths: Paths): number {
  const daemon = readJson(paths.daemonFile) as { port?: unknown } | undefined;
  if (isPort(daemon?.port)) return daemon.port;
  const config = readJson(paths.configFile) as { port?: unknown } | undefined;
  if (isPort(config?.port)) return config.port;
  return DEFAULT_PORT;
}

function readToken(paths: Paths): string | null {
  try {
    const t = readFileSync(paths.tokenFile, "utf8").trim();
    return t === "" ? null : t;
  } catch {
    return null;
  }
}

/** ingest.md 6 / config.md 2: one line per error, tab-separated, never more than one line. */
export function logError(paths: Paths, code: string, message: string): void {
  try {
    mkdirSync(paths.stateDir, { recursive: true });
    const clean = message.replace(/[\r\n\t]+/g, " ");
    appendFileSync(paths.hookErrorsFile, `${new Date().toISOString()}\t${code}\t${clean}\n`);
  } catch {
    // The hook never fails because logging failed.
  }
}

/** D-11: one file per envelope, then the oldest beyond 1000 are deleted (by name). */
export function spool(envelope: IngestEnvelope, paths: Paths): void {
  try {
    mkdirSync(paths.spoolDir, { recursive: true });
    const name = `${envelope.sentAt}-${envelope.origin.hookPid}-${envelope.seq}.json`;
    const target = path.join(paths.spoolDir, name);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(envelope));
    renameSync(tmp, target);
    const files = readdirSync(paths.spoolDir).filter((f) => f.endsWith(".json")).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_SPOOL))) {
      rmSync(path.join(paths.spoolDir, old), { force: true });
    }
  } catch {
    // Spooling is best effort; the hook still exits 0.
  }
}

/** POST to the daemon; spool on network error, timeout, 401/403, 5xx; log 400 and drop. */
export async function deliver(envelope: IngestEnvelope, paths: Paths): Promise<void> {
  const token = readToken(paths);
  if (token === null) {
    spool(envelope, paths);
    return;
  }
  const port = readPort(paths);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/ingest/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(800),
    });
  } catch {
    spool(envelope, paths);
    return;
  }
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 400) {
    let message = "invalid envelope";
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch {
      // keep the default message
    }
    logError(paths, "invalid_envelope", message);
    return;
  }
  spool(envelope, paths);
}
