import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import type { DaemonDeps } from "./internal.js";
import { registerSecurity } from "./security.js";
import { registerWs } from "./ws.js";
import { registerApi } from "./routes/api.js";
import { registerPair } from "./routes/pair.js";
import { registerIngest } from "./routes/ingest.js";
import { registerBridge } from "./routes/bridge.js";
import { registerStatic } from "./routes/static.js";
import { registerTest } from "./routes/test.js";

export async function buildApp(
  deps: DaemonDeps,
  opts: { uiDir: string | null; testMode: boolean },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const portOf = (): number => {
    const addr = app.server.address();
    return typeof addr === "object" && addr !== null ? addr.port : 0;
  };

  await app.register(cookie);
  await app.register(websocket);
  registerSecurity(app, { port: portOf, auth: deps.auth, testMode: opts.testMode });

  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "invalid_request", message: err.message.slice(0, 300) } });
    }
    deps.log.error({ err: String(err) }, "request failed");
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "not found" } }),
  );

  app.get("/healthz", { config: { realm: "none" } }, async () => ({
    ok: true,
    pid: process.pid,
    version: deps.version,
  }));

  const hub = registerWs(app, deps, portOf);
  registerStatic(app, opts.uiDir);
  registerIngest(app, deps);
  registerApi(app, deps, portOf, hub);
  registerPair(app, deps, portOf);
  registerBridge(app, deps);
  registerTest(app, deps, opts.testMode);

  return app;
}
