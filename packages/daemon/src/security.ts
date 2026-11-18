import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "./internal.js";

export type Realm = "none" | "bearer" | "browser" | "browser-or-bearer";

/**
 * Route config shape: `{ config: { realm: Realm, bodyLimit?: number } }` plus the optional
 * fields api.md 1 and 4 need. `rateLimit.windowMs` defaults to 1000 (per second); the
 * pair route sets 60000 for its "10 per minute" limit.
 */
export interface RouteSecurityConfig {
  realm: Realm;
  bodyLimit?: number;
  allowedOrigins?: string[];
  rateLimit?: { perSession?: number; total: number; windowMs?: number };
}

const SESSION_COOKIE = "mc_session";
const CSP = (port: number): string =>
  `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`;

type ErrorCode =
  | "bad_host"
  | "forbidden"
  | "unauthorized"
  | "invalid_request"
  | "rate_limited";

function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function routeConfig(request: FastifyRequest): Partial<RouteSecurityConfig> {
  return (request.routeOptions.config ?? {}) as Partial<RouteSecurityConfig>;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function singleHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function defaultBodyLimit(url: string): number {
  return url.startsWith("/ingest/") ? 16 * 1024 : 4 * 1024;
}

type Verdict = "ok" | "unauthorized" | "forbidden";

/** api.md 2. `none` always passes; a realm with no applicable credential is 401. */
function checkRealm(request: FastifyRequest, realm: Realm, auth: Auth, port: number): Verdict {
  if (realm === "none") return "ok";
  const wantsBearer = realm === "bearer" || realm === "browser-or-bearer";
  const wantsBrowser = realm === "browser" || realm === "browser-or-bearer";
  const authorization = singleHeader(request.headers.authorization);
  const cookie = cookieValue(singleHeader(request.headers.cookie), SESSION_COOKIE);
  const bearerPresent = wantsBearer && authorization !== undefined;
  const browserPresent = wantsBrowser && cookie !== undefined;
  if (!bearerPresent && !browserPresent) return "unauthorized";

  const origin = singleHeader(request.headers.origin);
  if (bearerPresent && auth.checkBearer(authorization)) {
    const allowed = (routeConfig(request).allowedOrigins ?? []).includes(origin ?? "");
    if (origin === undefined || allowed) return "ok";
  }
  if (browserPresent) {
    const ownOrigin = origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    const csrf = singleHeader(request.headers["x-mc-csrf"]);
    if (ownOrigin && auth.checkBrowser(cookie, csrf, request.method)) return "ok";
  }
  return "forbidden";
}

/** Sliding window in memory: hits inside the last `windowMs`, oldest pruned. */
function recentHits(hits: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent;
}

export function registerSecurity(
  app: FastifyInstance,
  opts: { port: () => number; auth: Auth; testMode: boolean },
): void {
  const { port: portOf, auth } = opts;
  const hits = new Map<string, number[]>();

  // Fastify's own body limit follows api.md 1 too, so a chunked body is cut off at parse time.
  app.addHook("onRoute", (route) => {
    if (route.bodyLimit !== undefined) return;
    const cfg = (route.config ?? {}) as Partial<RouteSecurityConfig>;
    route.bodyLimit = cfg.bodyLimit ?? defaultBodyLimit(route.url);
  });

  app.addHook("onRequest", async (request, reply) => {
    const port = portOf();

    // 1. Host
    const host = singleHeader(request.headers.host);
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return sendError(reply, 421, "bad_host", "Host header is not the daemon address");
    }

    // 2. OPTIONS: no CORS, never a preflight answer
    if (request.method === "OPTIONS") {
      return sendError(reply, 405, "invalid_request", "method not allowed");
    }

    const cfg = routeConfig(request);
    const realm: Realm = cfg.realm ?? "browser-or-bearer";

    // 3. Realm
    const verdict = checkRealm(request, realm, auth, port);
    if (verdict === "unauthorized") return sendError(reply, 401, "unauthorized", "credential required");
    if (verdict === "forbidden") return sendError(reply, 403, "forbidden", "credential rejected");

    // 4. Body size
    const limit = cfg.bodyLimit ?? defaultBodyLimit(request.url);
    const declared = Number(singleHeader(request.headers["content-length"]) ?? 0);
    if (declared > limit) return sendError(reply, 413, "invalid_request", "request body too large");

    // 5. Rate limit, keyed by route id (method + route template) and the session id for perSession
    const rl = cfg.rateLimit;
    if (rl) {
      const now = Date.now();
      const windowMs = rl.windowMs ?? 1000;
      const routeId = `${request.method} ${request.routeOptions.url ?? request.url}`;
      const sessionKey =
        rl.perSession === undefined
          ? undefined
          : `${routeId}|${String((request.params as { id?: unknown }).id ?? "")}`;
      const totalRecent = recentHits(hits, routeId, windowMs, now);
      const sessionRecent = sessionKey === undefined ? [] : recentHits(hits, sessionKey, windowMs, now);
      const overTotal = totalRecent.length >= rl.total;
      const overSession = sessionKey !== undefined && sessionRecent.length >= (rl.perSession ?? Infinity);
      if (overTotal || overSession) {
        return sendError(reply, 429, "rate_limited", "rate limit exceeded");
      }
      // Record only admitted requests, in both windows, so a refused one costs nothing.
      totalRecent.push(now);
      sessionRecent.push(now);
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/html")) {
      reply.header("Content-Security-Policy", CSP(portOf()));
    }
    return payload;
  });
}
