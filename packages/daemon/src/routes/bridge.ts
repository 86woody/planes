import type { FastifyInstance } from "fastify";
import type { DaemonDeps } from "../internal.js";

const VSCODE_KINDS = new Set<string>(["vscode-terminal", "vscode-extension"]);

export function registerBridge(app: FastifyInstance, deps: DaemonDeps): void {
  app.get(
    "/bridge/v1",
    { websocket: true, config: { realm: "bearer", allowedOrigins: ["vscode-file://vscode-app"] } },
    async (socket) => {
      deps.bridges.attach(socket);
    },
  );

  // A bridge window came or went: VS Code sessions may now match a different window.
  const off = deps.bridges.onChange(() => {
    for (const r of deps.sessions.records()) {
      if (!VSCODE_KINDS.has(r.session.host.kind)) continue;
      deps.focus
        .resolve(r.session.id)
        .catch((err: unknown) => deps.log.warn({ err: String(err) }, "focus resolve failed"));
    }
    deps.broadcast({ type: "daemon.update" });
  });
  app.addHook("onClose", async () => off());
}
