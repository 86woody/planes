import type { FastifyInstance } from "fastify";
import type { DaemonDeps } from "../internal.js";
import { fail, objectBody } from "./api.js";

const PAIR_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}-?[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}$/;
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export function registerPair(app: FastifyInstance, deps: DaemonDeps, portOf: () => number): void {
  // realm none: the browser pairs before it has a cookie. The Origin check below stands in for
  // the realm, so only this page can exchange a code (api.md 3).
  app.post(
    "/api/pair",
    { config: { realm: "none", rateLimit: { total: 10, windowMs: 60_000 } } },
    async (request, reply) => {
      const port = portOf();
      const origin = request.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        return fail(reply, 403, "forbidden", "pairing must come from the daemon's own page");
      }
      const body = objectBody(request.body);
      const code = body?.["code"];
      if (typeof code !== "string" || !PAIR_RE.test(code)) {
        return fail(reply, 400, "invalid_request", "code must be 8 characters");
      }
      const paired = deps.auth.pair(code);
      if (!paired) return fail(reply, 401, "pair_expired", "code unknown, expired or used");
      reply.setCookie("mc_session", paired.sessionCookie, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: COOKIE_MAX_AGE_S,
      });
      return { csrf: paired.csrf };
    },
  );
}
