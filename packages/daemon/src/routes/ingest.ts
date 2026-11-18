import type { FastifyInstance } from "fastify";
import type { SessionId } from "@mc/contracts";
import { validateEnvelope } from "@mc/contracts";
import type { DaemonDeps } from "../internal.js";
import { readGit } from "../git.js";
import { fail } from "./api.js";

export function registerIngest(app: FastifyInstance, deps: DaemonDeps): void {
  // api.md 4: 200 per second total; the hook spools on 429.
  app.post(
    "/ingest/v1/events",
    { config: { realm: "bearer", bodyLimit: 16 * 1024, rateLimit: { total: 200 } } },
    async (request, reply) => {
    const v = validateEnvelope(request.body);
    if (!v.ok) return fail(reply, 400, "invalid_envelope", (v.errors[0] ?? "invalid envelope").slice(0, 300));
    const env = v.value;

    // D-20: the id is "<adapter>:<nativeId>", so the previous record can be read before ingest.
    const id = `${env.adapter}:${env.nativeSessionId}` as SessionId;
    const prev = deps.sessions.get(id);
    const prevCwd = prev?.session.cwd;

    const { sessionId } = deps.sessions.ingest(env, deps.clock.now());
    const rec = deps.sessions.get(sessionId);

    if (!prev || JSON.stringify(prev.origin) !== JSON.stringify(rec?.origin ?? null)) {
      deps.focus
        .resolve(sessionId)
        .catch((err: unknown) => deps.log.warn({ err: String(err), sessionId }, "focus resolve failed"));
    }

    const cwd = env.payload.cwd;
    if (typeof cwd === "string" && cwd !== prevCwd) {
      readGit(cwd)
        .then((g) => deps.sessions.setGit(sessionId, g.project, g.branch))
        .catch((err: unknown) => deps.log.warn({ err: String(err), sessionId }, "git read failed"));
    }

    return reply.code(202).send({ accepted: true, sessionId });
    },
  );
}
