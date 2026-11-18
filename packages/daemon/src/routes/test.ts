import type { FastifyInstance } from "fastify";
import type { SessionId } from "@mc/contracts";
import type { FakePlatform } from "@mc/platform";
import type { DaemonDeps } from "../internal.js";
import { fail, objectBody } from "./api.js";

/** Test-only routes (D-19): registered only when testMode and MC_PLATFORM=fake; otherwise 404. */
export function registerTest(app: FastifyInstance, deps: DaemonDeps, testMode: boolean): void {
  if (!testMode || process.env["MC_PLATFORM"] !== "fake") return;
  const fake = deps.platform as FakePlatform;

  app.get("/api/test/fake-platform", { config: { realm: "bearer" } }, async () => ({ calls: fake.calls }));

  app.post("/api/test/fake-platform/foreground", { config: { realm: "bearer" } }, async (request, reply) => {
    const body = objectBody(request.body);
    const raw = body?.["sessionId"];
    if (raw !== null && typeof raw !== "string") return fail(reply, 400, "invalid_request", "sessionId must be a string or null");
    const rec = typeof raw === "string" ? deps.sessions.get(raw as SessionId) : undefined;
    fake.setScript({ foregroundSessionWindow: rec?.target?.window?.handle ?? null });
    return reply.code(204).send();
  });
}
