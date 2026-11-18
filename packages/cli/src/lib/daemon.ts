import { existsSync, readFileSync, rmSync } from "node:fs";
import type { CliPaths } from "./paths.js";

export interface DaemonFile {
  pid: number;
  port: number;
  startedAt?: string;
  version?: string;
}

export interface Running {
  pid: number;
  port: number;
  version: string;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export function readDaemonFile(paths: CliPaths): DaemonFile | null {
  let parsed: Partial<DaemonFile>;
  try {
    parsed = JSON.parse(readFileSync(paths.daemonFile, "utf8")) as Partial<DaemonFile>;
  } catch {
    return null;
  }
  if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
  return { pid: parsed.pid, port: parsed.port, ...(parsed.version ? { version: parsed.version } : {}), ...(parsed.startedAt ? { startedAt: parsed.startedAt } : {}) };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function healthz(port: number): Promise<{ pid: number; version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; pid?: unknown; version?: unknown };
    if (body.ok !== true || typeof body.pid !== "number") return null;
    return { pid: body.pid, version: typeof body.version === "string" ? body.version : "" };
  } catch {
    return null;
  }
}

/** Running means: daemon.json names a live pid and /healthz answers with that same pid. */
export async function findRunning(paths: CliPaths): Promise<Running | null> {
  const file = readDaemonFile(paths);
  if (!file || !isAlive(file.pid)) return null;
  const health = await healthz(file.port);
  if (!health || health.pid !== file.pid) return null;
  return { pid: file.pid, port: file.port, version: health.version };
}

export function readToken(paths: CliPaths): string | null {
  try {
    return readFileSync(paths.tokenFile, "utf8").trim();
  } catch {
    return null;
  }
}

export async function api(
  port: number,
  method: string,
  route: string,
  opts: { token?: string | null; body?: unknown; origin?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.origin) headers["origin"] = opts.origin;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export function removeDaemonFile(paths: CliPaths): void {
  if (existsSync(paths.daemonFile)) rmSync(paths.daemonFile, { force: true });
}
