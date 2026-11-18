import type { FastifyInstance, FastifyReply } from "fastify";
import type { Capabilities, DaemonInfo, SessionId, StateResponse } from "@mc/contracts";
import type { DaemonDeps } from "../internal.js";
import type { WsHub } from "../ws.js";

export function fail(
  reply: FastifyReply,
  status: number,
  code: "forbidden" | "unauthorized" | "not_found" | "invalid_request" | "invalid_envelope" | "pair_expired",
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

/** A JSON object body, or `{}` when the request carried none; null when the body is not an object. */
export function objectBody(body: unknown): Record<string, unknown> | null {
  if (body === undefined || body === null) return {};
  return typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function daemonInfo(deps: DaemonDeps, port: number): DaemonInfo {
  const configError = deps.config.error();
  return {
    pid: process.pid,
    version: deps.version,
    startedAt: deps.startedAt,
    port,
    configOk: configError === null,
    configError,
    bridges: deps.bridges.windows().length,
    copilot: deps.copilot.current(),
  };
}

export function buildState(deps: DaemonDeps, port: number, seq: number, capabilities: Capabilities): StateResponse {
  return { seq, sessions: deps.sessions.list(), daemon: daemonInfo(deps, port), capabilities };
}

export function registerApi(app: FastifyInstance, deps: DaemonDeps, portOf: () => number, hub: WsHub): void {
  const sessionId = (params: unknown): SessionId => (params as { id: string }).id as SessionId;

  app.get("/api/csrf", { config: { realm: "browser" } }, async (request, reply) => {
    const csrf = deps.auth.csrfFor(request.cookies["mc_session"]);
    if (csrf === null) return fail(reply, 401, "unauthorized", "no live browser session");
    return { csrf };
  });

  app.get("/api/state", { config: { realm: "browser-or-bearer" } }, async () => {
    const capabilities = await deps.capabilities.get();
    return buildState(deps, portOf(), hub.wireSeq(), capabilities);
  });

  app.post(
    "/api/sessions/:id/restore",
    { config: { realm: "browser-or-bearer", rateLimit: { perSession: 2, total: 5 } } },
    async (request, reply) => {
      const id = sessionId(request.params);
      const body = objectBody(request.body);
      if (body === null) return fail(reply, 400, "invalid_request", "body must be an object");
      if (body["source"] !== undefined && body["source"] !== "notification") {
        return fail(reply, 400, "invalid_request", "source must be \"notification\" when given");
      }
      if (!deps.sessions.get(id)) return fail(reply, 404, "not_found", "unknown session");
      const result = await deps.focus.restore(id, body["source"] === "notification" ? "notification" : "page");
      const session = deps.sessions.get(id)?.session;
      if (!session) return fail(reply, 404, "not_found", "unknown session");
      return { result, session };
    },
  );

  app.post("/api/sessions/:id/ack", { config: { realm: "browser-or-bearer" } }, async (request, reply) => {
    const id = sessionId(request.params);
    if (objectBody(request.body) === null) return fail(reply, 400, "invalid_request", "body must be an object");
    if (!deps.sessions.get(id)) return fail(reply, 404, "not_found", "unknown session");
    const session = deps.sessions.apply({ kind: "ack", sessionId: id, at: deps.clock.now() });
    if (!session) return fail(reply, 404, "not_found", "unknown session");
    return { session };
  });

  app.delete("/api/sessions/:id", { config: { realm: "browser-or-bearer" } }, async (request, reply) => {
    const id = sessionId(request.params);
    const rec = deps.sessions.get(id);
    if (!rec) return fail(reply, 404, "not_found", "unknown session");
    if (rec.session.state !== "ended" && rec.session.state !== "lost") {
      return fail(reply, 409, "invalid_request", "only ended or lost sessions can be removed");
    }
    deps.sessions.remove(id);
    return reply.code(204).send();
  });

  app.post("/api/notify/test", { config: { realm: "browser-or-bearer" } }, async () => deps.notifier.test());

  // D-57 (T117): the session's Copilot trace runs, names and numbers only.
  app.get("/api/sessions/:id/traces", { config: { realm: "browser-or-bearer" } }, async (request, reply) => {
    const id = sessionId(request.params);
    if (!deps.sessions.get(id)) return fail(reply, 404, "not_found", "unknown session");
    return { sessionId: id, runs: deps.traces.runs(id) };
  });

  // api.md 3: pair-code takes no body. A child scope accepts an empty body under any content type
  // (or none), still takes `{}` as JSON, and answers 415 for a non-empty non-JSON body.
  void app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      if ((body as Buffer).length === 0) done(null, undefined);
      else done(Object.assign(new Error("unsupported media type"), { statusCode: 415 }));
    });
    scope.post("/api/pair-code", { config: { realm: "bearer" } }, async () => deps.auth.issuePairCode());
  });
}
