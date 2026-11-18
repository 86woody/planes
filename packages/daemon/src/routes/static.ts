import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `GET /` (index.html with the mc-host meta, read once) and `/assets/*`. Both realm none. */
export function registerStatic(app: FastifyInstance, uiDir: string | null): void {
  if (uiDir === null) {
    app.get("/", { config: { realm: "none" } }, async (_request, reply) =>
      reply.code(503).type("text/plain; charset=utf-8").send("UI not built"),
    );
    return;
  }

  // Scoped so the realm applies to the static routes, which carry no config of their own.
  app.register(async (scope) => {
    scope.addHook("onRoute", (route) => {
      route.config = { ...route.config, realm: "none" };
    });
    await scope.register(fastifyStatic, {
      root: path.join(uiDir, "assets"),
      prefix: "/assets/",
      index: false,
    });
  });

  let html: Promise<string> | null = null;
  const indexHtml = (): Promise<string> => {
    html ??= readFile(path.join(uiDir, "index.html"), "utf8").then((raw) => {
      const meta = `<meta name="mc-host" content="${escapeHtml(os.hostname())}">`;
      return raw.includes("</head>") ? raw.replace("</head>", () => `${meta}</head>`) : `${meta}${raw}`;
    });
    return html;
  };

  app.get("/", { config: { realm: "none" } }, async (_request, reply) => {
    try {
      return reply.type("text/html; charset=utf-8").send(await indexHtml());
    } catch {
      html = null;
      return reply.code(503).type("text/plain; charset=utf-8").send("UI not built");
    }
  });
}
