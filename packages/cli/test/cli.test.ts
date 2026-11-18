import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import type { Io } from "../src/main.js";
import { REPO_ROOT, resolveCliPaths } from "../src/lib/paths.js";
import type { CliPaths } from "../src/lib/paths.js";
import { api, isAlive, readDaemonFile, readToken } from "../src/lib/daemon.js";

const FIXTURE = path.join(REPO_ROOT, "packages", "contracts", "fixtures", "ingest", "cc-session-start.json");
const T = 30_000;

let home: string;
let env: NodeJS.ProcessEnv;
let paths: CliPaths;
let out: string[];
let err: string[];
let io: Io;

function resetIo(): void {
  out = [];
  err = [];
  io = { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: process.cwd() };
}

async function cli(...argv: string[]): Promise<number> {
  return main(argv, io);
}

async function ingestFixture(): Promise<string> {
  const envelope = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
  const res = await api(readDaemonFile(paths)!.port, "POST", "/ingest/v1/events", { token: readToken(paths), body: envelope });
  expect(res.status).toBe(202);
  return (res.json as { sessionId: string }).sessionId;
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mc-cli-"));
  env = { ...process.env, MC_HOME: home, MC_PORT: "0", MC_PLATFORM: "fake", MC_TEST: "1" };
  paths = resolveCliPaths(env);
  resetIo();
});

afterEach(async () => {
  resetIo();
  await cli("stop");
  // Kill anything still alive from daemon.json, then remove the temp home.
  const left = readDaemonFile(paths);
  if (left && isAlive(left.pid)) {
    try {
      process.kill(left.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(home, { recursive: true, force: true });
});

describe("mc CLI", () => {
  it(
    "CLI-01 start launches the daemon and prints started pid= port=",
    async () => {
      expect(await cli("start")).toBe(0);
      expect(out.join("\n")).toMatch(/^started pid=\d+ port=\d+$/m);
    },
    T,
  );

  it(
    "CLI-02 start when running prints already running and exits 0",
    async () => {
      expect(await cli("start")).toBe(0);
      resetIo();
      expect(await cli("start")).toBe(0);
      expect(out.join("\n")).toMatch(/^already running pid=\d+ port=\d+$/m);
    },
    T,
  );

  it(
    "CLI-03 status prints the daemon line and one line per session",
    async () => {
      expect(await cli("start")).toBe(0);
      await ingestFixture();
      resetIo();
      expect(await cli("status")).toBe(0);
      expect(out[0]).toMatch(/^daemon pid=\d+ port=\d+ sessions=1$/);
      expect(out).toHaveLength(2);
      expect(out[1]).toMatch(/^MC-\d{2}\s/);
      expect(out[1]).toMatch(/\s{2}(Starting|Working|Idle|Needs permission|Needs input|Error|Done|Ended|Lost)\s/);
    },
    T,
  );

  it(
    "CLI-04 stop removes daemon.json within 5 s",
    async () => {
      expect(await cli("start")).toBe(0);
      expect(existsSync(paths.daemonFile)).toBe(true);
      const t0 = Date.now();
      expect(await cli("stop")).toBe(0);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(existsSync(paths.daemonFile)).toBe(false);
      expect(out).toContain("stopped");
    },
    T,
  );

  it(
    "CLI-05 open --print prints a URL with no code in it and a PAIR CODE line whose code /api/pair accepts once",
    async () => {
      expect(await cli("start")).toBe(0);
      resetIo();
      expect(await cli("open", "--print")).toBe(0);
      const text = out.join("\n");
      const url = /^URL {2}(\S+)$/m.exec(text)?.[1];
      const code = /^PAIR CODE {2}([0-9A-Z]{4}-[0-9A-Z]{4}) {2}\(valid 60 s\)$/m.exec(text)?.[1];
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(code).toBeDefined();
      expect(url).not.toContain(code!.replace("-", ""));
      expect(url).not.toContain(code!);

      const port = readDaemonFile(paths)!.port;
      const origin = `http://127.0.0.1:${port}`;
      const first = await api(port, "POST", "/api/pair", { body: { code }, origin });
      expect(first.status).toBe(200);
      const second = await api(port, "POST", "/api/pair", { body: { code }, origin });
      expect(second.status).toBe(401);
    },
    T,
  );

  it(
    "CLI-06 restore with a mission-control:// URI calls the fake focus with source notification",
    async () => {
      expect(await cli("start")).toBe(0);
      const sessionId = await ingestFixture();
      resetIo();
      const uri = `mission-control://restore/${encodeURIComponent(sessionId)}`;
      expect(await cli("restore", uri, "--from-notification")).toBe(0);
      const port = readDaemonFile(paths)!.port;
      const calls = await api(port, "GET", "/api/test/fake-platform", { token: readToken(paths) });
      const methods = (calls.json as { calls: { method: string }[] }).calls.map((c) => c.method);
      expect(methods).toContain("focus");
    },
    T,
  );

  it(
    "CLI-07 restore of an unknown id exits 0 and falls back to open",
    async () => {
      expect(await cli("start")).toBe(0);
      resetIo();
      expect(await cli("restore", "mission-control://restore/claude-code%3Anope")).toBe(0);
      expect(out.join("\n")).toMatch(/^URL {2}http:\/\/127\.0\.0\.1:\d+\/$/m);
    },
    T,
  );

  it(
    "CLI-08 token rotate changes the token file and old bearer requests get 403 after restart",
    async () => {
      expect(await cli("start")).toBe(0);
      const before = readToken(paths);
      expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/);
      resetIo();
      expect(await cli("token", "rotate")).toBe(0);
      expect(out.join("\n")).toContain("token rotated; daemon stopped.");
      const after = readToken(paths);
      expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(after).not.toBe(before);

      expect(await cli("start")).toBe(0);
      const port = readDaemonFile(paths)!.port;
      // api.md 1: no credential is 401, a bad credential is 403 (D-31).
      expect((await api(port, "GET", "/api/state", { token: before })).status).toBe(403);
      expect((await api(port, "GET", "/api/state")).status).toBe(401);
      expect((await api(port, "GET", "/api/state", { token: after })).status).toBe(200);
    },
    T,
  );

  it("CLI-09 unknown command exits 2 with usage", async () => {
    expect(await cli("frobnicate")).toBe(2);
    expect(err.join("\n")).toMatch(/unknown command: frobnicate/);
    expect(err.join("\n")).toMatch(/usage: mc <command>/);
  });

  it(
    "CLI-10 status with the daemon down exits 1",
    async () => {
      expect(await cli("status")).toBe(1);
      expect(err.join("\n")).toMatch(/daemon not running/);
    },
    T,
  );
});
