import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateEnvelope, validateTracesResponse, type SessionId, type TraceRun } from "@mc/contracts";
import { buildApp } from "../src/app.js";
import { createTraceStore, type TraceStore } from "../src/traces.js";
import { makeDeps, type TestDeps } from "./support/deps.js";

const FIXTURES = fileURLToPath(new URL("../../contracts/fixtures/ingest/", import.meta.url));
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const SID = "copilot-cli:abc123";
const SECRET = "SECRET-ARGS-7731";
const silent = { info() {}, warn() {}, error() {} };

type Attrs = Record<string, unknown>;
interface SpanOpts {
  trace?: string;
  id: string;
  parent?: string;
  name: string;
  start: number;
  end?: number;
  attrs?: Attrs;
  code?: number;
  events?: { name: string; time: number }[];
}

/** A Copilot OTel span record in object-attribute form, times in epoch ms. */
function span(o: SpanOpts): Record<string, unknown> {
  return {
    type: "span",
    traceId: o.trace ?? "trace-1",
    spanId: o.id,
    parentSpanId: o.parent ?? "",
    name: o.name,
    startTime: o.start,
    endTime: o.end ?? o.start + 1000,
    status: { code: o.code ?? 1 },
    attributes: o.attrs ?? {},
    events: o.events ?? [],
  };
}

function rootSpan(trace = "trace-1", start = T0): Record<string, unknown> {
  return span({
    trace,
    id: "root",
    name: "invoke_agent",
    start,
    end: start + 10_000,
    attrs: { "github.copilot.agent.type": "cli", "github.copilot.nano_aiu": 42, "github.copilot.turn_count": 2 },
  });
}

let t: TestDeps;
let app: FastifyInstance | undefined;
const stores: TraceStore[] = [];

const newStore = (): TraceStore => {
  const s = createTraceStore({ clock: t.clock, log: silent, paths: t.paths, sessions: t.deps.sessions });
  stores.push(s);
  return s;
};

/** Ingests a session fixture so the route has a real session to answer for. */
function ingestSession(): SessionId {
  const env = JSON.parse(readFileSync(path.join(FIXTURES, "cc-session-start.json"), "utf8")) as Record<string, unknown>;
  env["sentAt"] = t.clock.now();
  const v = validateEnvelope(env);
  if (!v.ok) throw new Error(v.errors.join("; "));
  return t.deps.sessions.ingest(v.value, t.clock.now()).sessionId;
}

const fileFor = (sid: string): string =>
  path.join(t.paths.stateDir, "traces", `${encodeURIComponent(sid)}.json`);

beforeEach(async () => {
  t = await makeDeps();
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  for (const s of stores.splice(0)) await s.flush();
  await t.dispose();
});

describe("traces (D-57)", () => {
  it("TT-01 spans of one trace build one complete run with kinds, links, tokens and ttft in ms", async () => {
    const store = newStore();
    const recs = [
      rootSpan(),
      span({
        id: "c1", parent: "root", name: "chat claude-sonnet-5.5", start: T0 + 100, end: T0 + 1100,
        attrs: {
          "gen_ai.response.model": "claude-sonnet-5.5", "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.output_tokens": 80, "gen_ai.response.time_to_first_chunk": 0.25,
          "github.copilot.server_duration": 900, "gen_ai.input.messages": SECRET,
        },
        events: [{ name: "gen_ai.choice", time: T0 + 1000 }],
      }),
      span({ id: "t1", parent: "root", name: "execute_tool powershell", start: T0 + 1200, end: T0 + 1500, attrs: { "gen_ai.tool.name": "powershell" } }),
      span({ id: "c2", parent: "root", name: "chat claude-sonnet-5.5", start: T0 + 1600, end: T0 + 2600, attrs: { "gen_ai.usage.input_tokens": 1300, "gen_ai.usage.output_tokens": 90 } }),
      span({ id: "s1", parent: "root", name: "execute_tool skill", start: T0 + 2700, end: T0 + 2800, attrs: { "gen_ai.skill.name": "pdf" } }),
      span({
        id: "k1", parent: "root", name: "chat claude-sonnet-5.5", start: T0 + 3000, end: T0 + 3500,
        attrs: { "github.copilot.request.type": "compaction", "gen_ai.usage.input_tokens": 900, "gen_ai.usage.output_tokens": 200 },
      }),
    ];
    for (const r of recs) store.addSpan(SID, r);

    const runs = store.runs(SID);
    expect(runs).toHaveLength(1);
    const run = runs[0] as TraceRun;
    expect(run.complete).toBe(true);
    expect(run.durationMs).toBe(10_000);
    expect(run.agent).toBe("cli");
    expect(run.nanoAiu).toBe(42);
    expect(run.turnCount).toBe(2);
    expect(run.spans.map((s) => s.spanId)).toEqual(["root", "c1", "t1", "c2", "s1", "k1"]);
    expect(run.spans.map((s) => s.kind)).toEqual(["agent", "chat", "tool", "chat", "skill", "compaction"]);
    const c1 = run.spans[1];
    expect(c1?.parentSpanId).toBe("root");
    expect(c1?.inputTokens).toBe(1200);
    expect(c1?.outputTokens).toBe(80);
    expect(c1?.ttftMs).toBe(250);
    expect(c1?.serverMs).toBe(900);
    expect(c1?.model).toBe("claude-sonnet-5.5");
    expect(run.spans[2]?.tool).toBe("powershell");
    expect(run.spans[4]?.tool).toBe("pdf");
    expect(c1?.events).toEqual([{ name: "gen_ai.choice", at: new Date(T0 + 1000).toISOString() }]);
    expect(validateTracesResponse({ sessionId: SID, runs }).ok).toBe(true);
  });

  it("TT-02 spans that arrive before their root are incomplete until the root arrives", () => {
    const store = newStore();
    store.addSpan(SID, span({ id: "c1", parent: "root", name: "chat m", start: T0 + 100 }));
    store.addSpan(SID, span({ id: "t1", parent: "root", name: "execute_tool powershell", start: T0 + 1200 }));
    let run = store.runs(SID)[0] as TraceRun;
    expect(run.complete).toBe(false);
    expect(run.durationMs).toBeNull();
    expect(run.status).toBe("unset");
    expect(run.spans).toHaveLength(2);

    store.addSpan(SID, rootSpan());
    run = store.runs(SID)[0] as TraceRun;
    expect(run.complete).toBe(true);
    expect(run.durationMs).toBe(10_000);
    expect(run.spans[0]?.kind).toBe("agent");
  });

  it("TT-03 a duplicate spanId replaces, more than 500 spans count droppedSpans, more than 50 runs keep the newest 50", () => {
    const store = newStore();
    store.addSpan(SID, span({ id: "c1", parent: "root", name: "chat a", start: T0 + 100 }));
    store.addSpan(SID, span({ id: "c1", parent: "root", name: "chat b", start: T0 + 100 }));
    expect(store.runs(SID)[0]?.spans).toHaveLength(1);
    expect(store.runs(SID)[0]?.spans[0]?.name).toBe("chat b");

    const big = newStore();
    big.addSpan(SID, rootSpan("big"));
    for (let i = 0; i < 510; i++) {
      big.addSpan(SID, span({ trace: "big", id: `c${i}`, parent: "root", name: "chat m", start: T0 + 100 + i }));
    }
    const bigRun = big.runs(SID)[0] as TraceRun;
    expect(bigRun.spans).toHaveLength(500);
    expect(bigRun.droppedSpans).toBe(11);
    expect(bigRun.spans[0]?.kind).toBe("agent");

    const many = newStore();
    for (let i = 0; i < 55; i++) {
      many.addSpan(SID, rootSpan(`t${i}`, T0 + i * 1000));
    }
    const runs = many.runs(SID);
    expect(runs).toHaveLength(50);
    expect(runs[0]?.traceId).toBe("t5");
    expect(runs[49]?.traceId).toBe("t54");
  });

  it("TT-04 an attribute not on the copy list is not in the stored JSON file or the route body", async () => {
    const store = newStore();
    t.deps.traces = store;
    const sid = ingestSession();
    store.addSpan(sid, rootSpan());
    store.addSpan(
      sid,
      span({
        id: "c1", parent: "root", name: "chat m", start: T0 + 100,
        attrs: { "gen_ai.input.messages": SECRET, "gen_ai.tool.call.arguments": SECRET },
      }),
    );
    await store.flush();
    expect(readFileSync(fileFor(sid), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(store.runs(sid))).not.toContain(SECRET);

    app = await buildApp(t.deps, { uiDir: null, testMode: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${encodeURIComponent(sid)}/traces`,
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${t.deps.auth.token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"traceId":"trace-1"');
    expect(res.body).not.toContain(SECRET);
  });

  it("TT-05 the route: 404 for an unknown id; 200 with runs for a known one", async () => {
    const store = newStore();
    t.deps.traces = store;
    const sid = ingestSession();
    store.addSpan(sid, rootSpan());
    store.addSpan(sid, span({ id: "c1", parent: "root", name: "chat m", start: T0 + 100, attrs: { "gen_ai.input.messages": SECRET } }));

    app = await buildApp(t.deps, { uiDir: null, testMode: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${t.deps.auth.token()}` };

    const missing = await app.inject({ method: "GET", url: "/api/sessions/nope%3Anothing/traces", headers });
    expect(missing.statusCode).toBe(404);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${encodeURIComponent(sid)}/traces`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; runs: TraceRun[] };
    expect(body.sessionId).toBe(sid);
    expect(body.runs).toHaveLength(1);
    expect(validateTracesResponse(body).ok).toBe(true);
    expect(res.body).not.toContain(SECRET);
  });

  it("TT-06 flush writes the file, a new store reads it back, removing the session deletes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sid = ingestSession();
    const store = newStore();
    store.addSpan(sid, rootSpan());
    expect(existsSync(fileFor(sid))).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(existsSync(fileFor(sid))).toBe(false);
    vi.advanceTimersByTime(1);
    await store.flush();
    expect(existsSync(fileFor(sid))).toBe(true);
    vi.useRealTimers();

    const reread = newStore();
    expect(reread.runs(sid)).toEqual(store.runs(sid));

    t.deps.sessions.remove(sid);
    expect(existsSync(fileFor(sid))).toBe(false);
  });
});
