import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { wsHub } from "../src/ws.js";
import { makeDeps, type TestDeps } from "./support/deps.js";

const FIXTURES = fileURLToPath(new URL("../../contracts/fixtures/ingest/", import.meta.url));

type Msg = { type: string; seq: number; [k: string]: unknown };

let t: TestDeps;
let app: FastifyInstance;
let port = 0;
let cookie = "";
const sockets: WebSocket[] = [];

const origin = (): string => `http://127.0.0.1:${port}`;

function open(headers: Record<string, string> = { cookie, origin: origin() }): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { host: `127.0.0.1:${port}`, ...headers } });
  sockets.push(ws);
  return ws;
}

/** Collects every message until `until` returns true or the timeout passes. */
function collect(ws: WebSocket, until: (m: Msg[]) => boolean, timeoutMs = 1500): Promise<Msg[]> {
  const got: Msg[] = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(got), timeoutMs);
    ws.on("message", (data) => {
      got.push(JSON.parse(data.toString()) as Msg);
      if (until(got)) {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
}

function nextOpen(ws: WebSocket): Promise<Msg[]> {
  return collect(ws, (m) => m.length >= 1, 1500);
}

function envelope(): Record<string, unknown> {
  const env = JSON.parse(readFileSync(path.join(FIXTURES, "cc-session-start.json"), "utf8")) as Record<string, unknown>;
  env["sentAt"] = t.clock.now();
  return env;
}

beforeEach(async () => {
  t = await makeDeps();
  // Focus is not under test here; a no-op keeps upsert counts to what each test causes.
  vi.spyOn(t.deps.focus, "resolve").mockResolvedValue();
  app = await buildApp(t.deps, { uiDir: null, testMode: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const { code } = t.deps.auth.issuePairCode();
  const paired = t.deps.auth.pair(code);
  cookie = `mc_session=${paired?.sessionCookie ?? ""}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.terminate();
  await app.close();
  await t.dispose();
});

describe("T026 WebSocket", () => {
  it("WS-01 hello carries the full state and its seq", async () => {
    t.deps.sessions.ingest(envelope() as never, t.clock.now());
    const ws = open();
    const [hello] = await nextOpen(ws);
    expect(hello?.type).toBe("hello");
    expect(hello?.seq).toBe(0);
    const state = hello?.["state"] as { seq: number; sessions: { id: string }[]; daemon: { port: number } };
    expect(state.seq).toBe(hello?.seq);
    expect(state.sessions.map((s) => s.id)).toContain("claude-code:fixture-1");
    expect(state.daemon.port).toBe(port);
  });

  it("WS-02 an ingest produces session.upsert with seq hello+1", async () => {
    const ws = open();
    const [hello] = await nextOpen(ws);
    const got = collect(ws, (m) => m.some((x) => x.type === "session.upsert"));
    t.deps.sessions.ingest(envelope() as never, t.clock.now());
    const msgs = await got;
    const upsert = msgs.find((m) => m.type === "session.upsert");
    expect(upsert?.seq).toBe((hello?.seq ?? -1) + 1);
  });

  it("WS-03 two upserts for one session within 100 ms are coalesced into one", async () => {
    const ws = open();
    await nextOpen(ws);
    const got = collect(ws, () => false, 400);
    t.deps.sessions.ingest(envelope() as never, t.clock.now());
    t.deps.sessions.ingest(envelope() as never, t.clock.now());
    const msgs = await got;
    expect(msgs.filter((m) => m.type === "session.upsert")).toHaveLength(1);
  });

  it("WS-04 a client message other than ping closes the socket with 1008", async () => {
    const ws = open();
    await nextOpen(ws);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ type: "ping" }));
    ws.send(JSON.stringify({ type: "notify" }));
    expect(await closed).toBe(1008);
  });

  it("WS-05 upgrade without the cookie or with a foreign Origin is refused", async () => {
    const noCookie = open({ origin: origin() });
    const codeNoCookie = await new Promise<number>((resolve, reject) => {
      noCookie.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      noCookie.on("error", reject);
    });
    expect(codeNoCookie).toBe(401);

    const foreign = open({ cookie, origin: "http://evil.example" });
    const codeForeign = await new Promise<number>((resolve, reject) => {
      foreign.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      foreign.on("error", reject);
    });
    expect(codeForeign).toBe(403);
  });

  it("WS-06 broadcast notify and highlight reach connected clients with contiguous seqs", async () => {
    const ws = open();
    const [hello] = await nextOpen(ws);
    const got = collect(ws, (m) => m.length >= 2);
    const notification = {
      sessionId: "claude-code:fixture-1",
      title: "MISSION CONTROL",
      body: "needs input",
      urgency: "normal",
      tag: "mc-1",
    };
    wsHub.emit("msg", { type: "notify", notification });
    wsHub.emit("msg", { type: "highlight", sessionId: "claude-code:fixture-1" });
    const msgs = await got;
    expect(msgs.map((m) => m.type)).toEqual(["notify", "highlight"]);
    expect(msgs[0]?.seq).toBe((hello?.seq ?? -1) + 1);
    expect(msgs[1]?.seq).toBe((hello?.seq ?? -1) + 2);
  });
});
