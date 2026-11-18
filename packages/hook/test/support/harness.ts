// Test helpers: spawn the BUILT hook (dist/mc-hook.js) with MC_HOME in a temp dir, and a fake
// daemon on port 0 that records POST bodies. Nothing here touches the real config or state.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const TOKEN = "test-token-abc123";
const HOOK = fileURLToPath(new URL("../../dist/mc-hook.js", import.meta.url));
const RAW_DIR = fileURLToPath(new URL("../../../contracts/fixtures/ingest/raw/", import.meta.url));

export function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mc-hook-"));
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

export function rawFixtures(): string[] {
  return readdirSync(RAW_DIR).filter((f) => f.startsWith("cc-") && f.endsWith(".json")).sort();
}

export function readRaw(name: string): string {
  return readFileSync(join(RAW_DIR, name), "utf8");
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export function runHook(
  args: readonly string[],
  opts: { home: string; stdin?: string; env?: Record<string, string> },
): Promise<HookRun> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
      env: { ...process.env, MC_HOME: opts.home, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
  });
}

export interface FakeDaemon {
  port: number;
  bodies: string[];
  authorizations: (string | undefined)[];
  close(): Promise<void>;
}

/** mode "ok": 202 to every POST. mode "hang": reads the body and never answers. */
export async function startFakeDaemon(home: string, mode: "ok" | "hang" = "ok"): Promise<FakeDaemon> {
  const bodies: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      bodies.push(body);
      authorizations.push(req.headers.authorization);
      if (mode === "hang") return;
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, sessionId: "claude-code:fixture-1" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "daemon.json"),
    JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), version: "0.0.0" }),
  );
  writeFileSync(join(state, "token"), TOKEN);
  return {
    port,
    bodies,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function spoolFiles(home: string): string[] {
  try {
    return readdirSync(join(home, "state", "spool")).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export function errorLines(home: string): string[] {
  try {
    return readFileSync(join(home, "state", "hook-errors.log"), "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}
