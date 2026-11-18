import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import { registerSecurity } from "../src/security.js";
import type { Auth, Clock, Paths } from "../src/internal.js";

const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

let dirs: string[] = [];
let clock: { t: number } & Clock;

function makePaths(): Paths {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mc-sec-"));
  dirs.push(dir);
  const stateDir = path.join(dir, "state");
  return {
    configDir: dir,
    stateDir,
    configFile: path.join(dir, "config.json"),
    tokenFile: path.join(stateDir, "token"),
    daemonFile: path.join(stateDir, "daemon.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    eventsFile: path.join(stateDir, "events.jsonl"),
    spoolDir: path.join(stateDir, "spool"),
    hookErrorsFile: path.join(stateDir, "hook-errors.log"),
    logFile: path.join(stateDir, "daemon.log"),
    fakePlatformFile: path.join(stateDir, "fake-platform.json"),
    installManifestFile: path.join(stateDir, "install.json"),
  };
}

interface Harness {
  app: FastifyInstance;
  port: number;
  host: string;
  origin: string;
  close(): Promise<void>;
}

async function harness(auth: Auth): Promise<Harness> {
  const app = Fastify();
  let port = 0;
  registerSecurity(app, { port: () => port, auth, testMode: false });
  app.get("/none", { config: { realm: "none" } }, async () => ({ ok: true }));
  app.get("/none-html", { config: { realm: "none" } }, async (_req, reply) =>
    reply.type("text/html").send("<!doctype html><html></html>"),
  );
  app.get("/bearer", { config: { realm: "bearer" } }, async () => ({ ok: true }));
  app.get("/bearer-own-origin", { config: { realm: "bearer", allowedOrigins: ["vscode-file://vscode-app"] } }, async () => ({ ok: true }));
  app.post("/browser", { config: { realm: "browser" } }, async () => ({ ok: true }));
  app.post("/api/sessions/:id/restore", {
    config: { realm: "browser-or-bearer", rateLimit: { perSession: 2, total: 5 } },
  }, async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const host = `127.0.0.1:${port}`;
  return {
    app,
    port,
    host,
    origin: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

/** Pair through the Auth API and return the cookie and csrf, the way /api/pair would. */
function pairOnce(auth: Auth): { cookie: string; csrf: string } {
  const { code } = auth.issuePairCode();
  const paired = auth.pair(code);
  if (paired === null) throw new Error("pairing failed in test setup");
  return { cookie: paired.sessionCookie, csrf: paired.csrf };
}

beforeEach(() => {
  clock = { t: 1_700_000_000_000, now() { return this.t; } };
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("T015 auth and security", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it("SEC-01 Host evil.example:47800 gets 421 bad_host", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "GET",
      url: "/none",
      headers: { host: "evil.example:47800" },
    });
    expect(res.statusCode).toBe(421);
    expect(res.json()).toEqual({ error: { code: "bad_host", message: expect.any(String) } });
  });

  it("SEC-02 Host localhost:<port> and 127.0.0.1:<port> are accepted", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const a = await h.app.inject({ method: "GET", url: "/none", headers: { host: `127.0.0.1:${h.port}` } });
    const b = await h.app.inject({ method: "GET", url: "/none", headers: { host: `localhost:${h.port}` } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it("SEC-03 OPTIONS gets 405 and no Access-Control headers", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/bearer",
      headers: { host: h.host, origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(405);
    const acHeaders = Object.keys(res.headers).filter((k) => k.startsWith("access-control-"));
    expect(acHeaders).toEqual([]);
  });

  it("SEC-04 bearer route without Authorization gets 401", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const res = await h.app.inject({ method: "GET", url: "/bearer", headers: { host: h.host } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("SEC-05 bearer route with Origin header gets 403 even with the right token", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "GET",
      url: "/bearer",
      headers: { host: h.host, authorization: `Bearer ${auth.token()}`, origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("SEC-06 browser POST without X-MC-CSRF gets 403", async () => {
    const auth = await createAuth(makePaths(), clock);
    const { cookie } = pairOnce(auth);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "POST",
      url: "/browser",
      headers: { host: h.host, origin: h.origin, cookie: `mc_session=${cookie}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("SEC-07 browser POST with a foreign Origin gets 403", async () => {
    const auth = await createAuth(makePaths(), clock);
    const { cookie, csrf } = pairOnce(auth);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "POST",
      url: "/browser",
      headers: {
        host: h.host,
        origin: "http://evil.example",
        cookie: `mc_session=${cookie}`,
        "x-mc-csrf": csrf,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("SEC-08 browser POST with cookie, CSRF and own Origin passes", async () => {
    const auth = await createAuth(makePaths(), clock);
    const { cookie, csrf } = pairOnce(auth);
    h = await harness(auth);
    const res = await h.app.inject({
      method: "POST",
      url: "/browser",
      headers: {
        host: h.host,
        origin: h.origin,
        cookie: `mc_session=${cookie}`,
        "x-mc-csrf": csrf,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("SEC-09 pair code is single use and expires after 60 s", async () => {
    const auth = await createAuth(makePaths(), clock);
    const first = auth.issuePairCode();
    expect(auth.pair(first.code)).not.toBeNull();
    expect(auth.pair(first.code)).toBeNull(); // single use

    const second = auth.issuePairCode();
    clock.t += 60_000;
    expect(auth.pair(second.code)).toBeNull(); // expired
  });

  it("SEC-10 token file is created with 43 chars and mode 0600 on POSIX", async () => {
    const paths = makePaths();
    await createAuth(paths, clock);
    const token = readFileSync(paths.tokenFile, "utf8");
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform === "win32") {
      const out = execFileSync("icacls", [paths.tokenFile], { encoding: "utf8" });
      expect(out).not.toMatch(/BUILTIN\\Users/i);
      expect(out).not.toMatch(/Everyone/i);
    } else {
      expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    }
  });

  it("SEC-11 restore rate limit returns 429 on the third call within a second for one session", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const send = () =>
      h!.app.inject({
        method: "POST",
        url: "/api/sessions/s1/restore",
        headers: { host: h!.host, authorization: `Bearer ${auth.token()}` },
        payload: {},
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
  });

  it("SEC-12 every response has no-store, nosniff and no-referrer; HTML has the CSP", async () => {
    const auth = await createAuth(makePaths(), clock);
    h = await harness(auth);
    const json = await h.app.inject({ method: "GET", url: "/none", headers: { host: h.host } });
    const html = await h.app.inject({ method: "GET", url: "/none-html", headers: { host: h.host } });
    const bad = await h.app.inject({ method: "GET", url: "/none", headers: { host: "evil.example" } });
    for (const res of [json, html, bad]) {
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    }
    expect(json.headers["content-security-policy"]).toBeUndefined();
    expect(html.headers["content-security-policy"]).toBe(
      `default-src 'self'; connect-src 'self' ws://127.0.0.1:${h.port} ws://localhost:${h.port}; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`,
    );
  });

  it("SEC-13 a paired browser session still passes checkBrowser after a new createAuth on the same stateDir, and browser-sessions.json contains no raw cookie or csrf", async () => {
    const paths = makePaths();
    const auth = await createAuth(paths, clock);
    const { cookie, csrf } = pairOnce(auth);
    const again = await createAuth(paths, clock);
    expect(again.checkBrowser(cookie, csrf, "POST")).toBe(true);
    await again.flush();
    const file = readFileSync(path.join(paths.stateDir, "browser-sessions.json"), "utf8");
    expect(file).not.toContain(cookie);
    expect(file).not.toContain(csrf);
    expect(JSON.parse(file)[0]).toEqual({ cookieSha256: expect.stringMatching(/^[0-9a-f]{64}$/), lastSeen: expect.any(Number) });
  });

  it("SEC-14 pair codes look like XXXX-XXXX, accept lower case and no dash, and die after 5 wrong attempts", async () => {
    const auth = await createAuth(makePaths(), clock);
    const issued = auth.issuePairCode();
    expect(issued.code).toMatch(CODE_RE);
    const raw = issued.code.replace("-", "");
    expect(auth.pair(raw.toLowerCase())).not.toBeNull();

    const next = auth.issuePairCode();
    const wrong = next.code.replace(/[0-9A-Z]$/, (c) => (c === "0" ? "1" : "0"));
    for (let i = 0; i < 5; i++) expect(auth.pair(wrong)).toBeNull();
    expect(auth.pair(next.code)).toBeNull(); // invalidated after the 5th wrong attempt
  });

  it("SEC-15 csrfFor returns the same csrf pair() returned, also after a new createAuth; null for an unknown cookie; a csrf from another cookie fails checkBrowser", async () => {
    const paths = makePaths();
    const auth = await createAuth(paths, clock);
    const a = pairOnce(auth);
    const b = pairOnce(auth);
    expect(auth.csrfFor(a.cookie)).toBe(a.csrf);
    expect(auth.csrfFor("not-a-cookie-value-00000000000000000000000")).toBeNull();
    expect(auth.checkBrowser(a.cookie, b.csrf, "POST")).toBe(false);

    const again = await createAuth(paths, clock);
    expect(again.csrfFor(a.cookie)).toBe(a.csrf);
  });
});
