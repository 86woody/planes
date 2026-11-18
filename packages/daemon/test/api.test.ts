import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeDeps, type TestDeps } from "./support/deps.js";

const FIXTURES = fileURLToPath(new URL("../../contracts/fixtures/ingest/", import.meta.url));
/** A throwaway git repo with a named branch, so readGit's answer does not depend on the checkout. */
function makeRepo(): { dir: string; project: string; branch: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mc-t026-repo-"));
  dirs.push(root);
  const project = "demo-project";
  const dir = path.join(root, project);
  mkdirSync(dir);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=mc-test", "-c", "user.email=mc-test@example.invalid", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  };
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("switch", "-q", "-c", "mc-t026-branch");
  return { dir, project, branch: "mc-t026-branch" };
}

function envelope(fixture: string, cwd?: string): Record<string, unknown> {
  const env = JSON.parse(readFileSync(path.join(FIXTURES, fixture), "utf8")) as Record<string, unknown> & {
    payload: Record<string, unknown>;
    sentAt: number;
  };
  env.sentAt = t.clock.now(); // keep the session inside the retention window of the test clock
  if (cwd !== undefined) env.payload["cwd"] = cwd;
  return env;
}

let t: TestDeps;
let app: FastifyInstance;
let port = 0;
const dirs: string[] = [];

const host = (): string => `127.0.0.1:${port}`;
const own = (): string => `http://127.0.0.1:${port}`;
const bearer = (extra: Record<string, string> = {}): Record<string, string> => ({
  host: host(),
  authorization: `Bearer ${t.deps.auth.token()}`,
  ...extra,
});

async function listen(testMode: boolean, uiDir: string | null = null): Promise<void> {
  app = await buildApp(t.deps, { uiDir, testMode });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : 0;
}

async function pairedCookie(): Promise<{ cookie: string; csrf: string }> {
  const { code } = t.deps.auth.issuePairCode();
  const res = await app.inject({
    method: "POST",
    url: "/api/pair",
    headers: { host: host(), origin: own(), "content-type": "application/json" },
    payload: { code },
  });
  expect(res.statusCode).toBe(200);
  const value = /mc_session=([^;]+)/.exec(String(res.headers["set-cookie"]))?.[1] ?? "";
  return { cookie: `mc_session=${value}`, csrf: (res.json() as { csrf: string }).csrf };
}

async function ingest(cwd?: string, fixture = "cc-session-start.json"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/ingest/v1/events",
    headers: bearer({ "content-type": "application/json" }),
    payload: envelope(fixture, cwd),
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { sessionId: string }).sessionId;
}

beforeEach(async () => {
  t = await makeDeps();
  await listen(false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await t.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env["MC_PLATFORM"];
});

describe("T026 API", () => {
  it("API-01 GET /healthz returns ok, pid and version without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { host: host() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, pid: process.pid, version: "0.0.0-test" });
  });

  it("API-02 POST /ingest/v1/events with a valid fixture returns 202 and the session appears in /api/state", async () => {
    const sessionId = await ingest();
    expect(sessionId).toBe("claude-code:fixture-1");
    const state = await app.inject({ method: "GET", url: "/api/state", headers: bearer() });
    expect(state.statusCode).toBe(200);
    const body = state.json() as { sessions: { id: string }[]; seq: number };
    expect(body.sessions.map((s) => s.id)).toContain(sessionId);
    expect(body.seq).toBe(0);
  });

  it("API-03 ingest with an invalid envelope returns 400 invalid_envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest/v1/events",
      headers: bearer({ "content-type": "application/json" }),
      payload: { v: 1 },
    });
    expect(res.statusCode).toBe(400);
    const err = (res.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("invalid_envelope");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("API-04 GET /api/state with bearer and no Origin works; with a foreign Origin 403", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/state", headers: bearer() });
    expect(ok.statusCode).toBe(200);
    const foreign = await app.inject({
      method: "GET",
      url: "/api/state",
      headers: bearer({ origin: "http://evil.example" }),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("API-05 pair-code then pair sets an HttpOnly SameSite=Strict cookie and returns csrf", async () => {
    const pc = await app.inject({ method: "POST", url: "/api/pair-code", headers: bearer() });
    expect(pc.statusCode).toBe(200);
    const { code } = pc.json() as { code: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/pair",
      headers: { host: host(), origin: own(), "content-type": "application/json" },
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { csrf: string }).csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^mc_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);

    // T072: pair-code takes no body, so no body under any content type works, and {} as JSON still does.
    for (const headers of [
      bearer(),
      bearer({ "content-type": "application/x-www-form-urlencoded" }),
      bearer({ "content-type": "application/json" }),
    ]) {
      const again = await app.inject({ method: "POST", url: "/api/pair-code", headers, ...(headers["content-type"] === "application/json" ? { payload: {} } : {}) });
      expect(again.statusCode).toBe(200);
    }
    const bad = await app.inject({ method: "POST", url: "/api/pair-code", headers: bearer({ "content-type": "application/octet-stream" }), payload: "x" });
    expect(bad.statusCode).toBe(415);
    const noAuth = await app.inject({ method: "POST", url: "/api/pair-code", headers: { host: host() } });
    expect(noAuth.statusCode).toBe(401);
  });

  it("API-06 browser POST restore with cookie and csrf returns RestoreResponse", async () => {
    const sessionId = await ingest();
    const { cookie, csrf } = await pairedCookie();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${encodeURIComponent(sessionId)}/restore`,
      headers: { host: host(), origin: own(), cookie, "x-mc-csrf": csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { code: string }; session: { id: string } };
    expect(typeof body.result.code).toBe("string");
    expect(body.session.id).toBe(sessionId);
  });

  it("API-07 restore of an unknown id is 404", async () => {
    const { cookie, csrf } = await pairedCookie();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope%3Anothing/restore",
      headers: { host: host(), origin: own(), cookie, "x-mc-csrf": csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("API-08 ack sets attention.acknowledged", async () => {
    // A Notification raises attention; ack only acknowledges an active attention (SM-23).
    const sessionId = await ingest(undefined, "cc-notification-permission.json");
    expect(t.deps.sessions.get(sessionId as never)?.session.attention.active).toBe(true);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${encodeURIComponent(sessionId)}/ack`,
      headers: bearer({ "content-type": "application/json" }),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { session: { attention: { acknowledged: boolean } } }).session.attention.acknowledged).toBe(true);
  });

  it("API-09 DELETE of a live session is 409; of an ended session 204", async () => {
    const sessionId = await ingest();
    const live = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(sessionId)}`,
      headers: bearer(),
    });
    expect(live.statusCode).toBe(409);

    t.deps.sessions.apply({ kind: "process_exited", sessionId: sessionId as never, at: t.clock.now() });
    expect(t.deps.sessions.get(sessionId as never)?.session.state).toBe("ended");
    const ended = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${encodeURIComponent(sessionId)}`,
      headers: bearer(),
    });
    expect(ended.statusCode).toBe(204);
    expect(t.deps.sessions.get(sessionId as never)).toBeUndefined();
  });

  it("API-10 GET / injects meta mc-host and the CSP header", async () => {
    const uiDir = mkdtempSync(path.join(os.tmpdir(), "mc-t026-ui-"));
    dirs.push(uiDir);
    writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><html><head><title>MC</title></head><body></body></html>");
    await app.close();
    await listen(false, uiDir);

    const res = await app.inject({ method: "GET", url: "/", headers: { host: host() } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<meta name="mc-host" content="${os.hostname()}">`);
    expect(res.body.indexOf("mc-host")).toBeLessThan(res.body.indexOf("</head>"));
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("API-11 test routes are 404 unless MC_TEST=1 and MC_PLATFORM=fake", async () => {
    // Test mode on, platform not fake: the route is not registered.
    await app.close();
    await listen(true);
    const notFake = await app.inject({ method: "GET", url: "/api/test/fake-platform", headers: bearer() });
    expect(notFake.statusCode).toBe(404);

    // Both set: the route answers with the fake's calls.
    await app.close();
    process.env["MC_PLATFORM"] = "fake";
    await listen(true);
    const on = await app.inject({ method: "GET", url: "/api/test/fake-platform", headers: bearer() });
    expect(on.statusCode).toBe(200);
    expect(Array.isArray((on.json() as { calls: unknown[] }).calls)).toBe(true);
  });

  it("API-12 ingest triggers focus.resolve and setGit for a new cwd", async () => {
    const resolve = vi.spyOn(t.deps.focus, "resolve").mockResolvedValue();
    const setGit = vi.spyOn(t.deps.sessions, "setGit");
    const repo = makeRepo();
    const sessionId = await ingest(repo.dir);
    expect(resolve).toHaveBeenCalledWith(sessionId);
    await vi.waitFor(() => expect(setGit).toHaveBeenCalledWith(sessionId, repo.project, repo.branch), {
      timeout: 1500,
    });
  });

  it("API-13 GET /api/csrf with the paired cookie returns the csrf pair returned; without a cookie 401", async () => {
    const { cookie, csrf } = await pairedCookie();
    const res = await app.inject({ method: "GET", url: "/api/csrf", headers: { host: host(), cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { csrf: string }).csrf).toBe(csrf);
    const none = await app.inject({ method: "GET", url: "/api/csrf", headers: { host: host() } });
    expect(none.statusCode).toBe(401);
  });
});
