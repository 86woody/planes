import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@mc/contracts";
import { validateSession, validateTracesResponse } from "@mc/contracts";
import { api } from "../src/api.js";
import { parseRoute, routeHref, type Route } from "../src/route.js";
import {
  availability,
  availabilityText,
  compact,
  contextOver,
  contextText,
  credits,
  durationText,
  errorRatePct,
  failedTools,
  sortValue,
  waitedMs,
} from "../src/telemetry-format.js";
import { sessionIn } from "./fixtures.js";
import { runOf, spanOf, telemetryOf } from "./telemetry-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const noTelemetry = (adapter: Session["adapter"]): Session => sessionIn("working", { adapter, telemetry: null });

describe("telemetry format", () => {
  it("UR-01 availability and its text by adapter, with telemetry set to data", () => {
    expect(availability(noTelemetry("copilot-cli"))).toBe("pending");
    expect(availabilityText("pending")).toBe("No data yet");
    expect(availability(noTelemetry("shell"))).toBe("na");
    expect(availabilityText("na")).toBe("n/a");
    expect(availability(noTelemetry("claude-code"))).toBe("pending");
    expect(availability(noTelemetry("codex"))).toBe("none");
    expect(availabilityText("none")).toBe("No data");
    expect(availability(sessionIn("working", { adapter: "shell", telemetry: telemetryOf() }))).toBe("data");
  });

  it("UR-02 compact, credits, context and duration text", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
    expect(compact(1000)).toBe("1.00k");
    expect(compact(12345)).toBe("12.3k");
    expect(compact(4_560_000)).toBe("4.56M");
    expect(compact(1.234e9)).toBe("1.23B");
    expect(compact(-5)).toBe("0");
    expect(compact(Number.NaN)).toBe("0");

    expect(credits(telemetryOf({ credits: { aiCredits: 12.5, nanoAiu: 999 } }))).toEqual({
      text: "12.50",
      unit: "AI Credits",
    });
    expect(credits(telemetryOf({ credits: { aiCredits: null, nanoAiu: 4_560_000 } }))).toEqual({
      text: "4.56M",
      unit: "nano-AIU",
    });
    expect(credits(telemetryOf())).toEqual({ text: "—", unit: "" });

    const ctx = (estimatePct: number | null) => telemetryOf({ context: { estimatePct } });
    expect(contextText(ctx(null))).toBe("—");
    expect(contextOver(ctx(null))).toBe(false);
    expect(contextText(ctx(85))).toBe("≈85%");
    expect(contextOver(ctx(85))).toBe(false);
    expect(contextText(ctx(85.4))).toBe("≈85%");
    expect(contextOver(ctx(85.4))).toBe(true);
    expect(contextText(ctx(86))).toBe("≈86%");
    expect(contextOver(ctx(86))).toBe(true);

    expect(durationText(null)).toBe("—");
    expect(durationText(430)).toBe("430 ms");
    expect(durationText(4210)).toBe("4.2 s");
    expect(durationText(185_000)).toBe("3m 05s");
    expect(durationText(3_720_000)).toBe("1h 02m");
  });

  it("UR-03 waited time, failed tools, error rate and sort values", () => {
    const t = telemetryOf({ permissions: { waitedMs: 1500 }, input: { waitedMs: 2500 } });
    expect(waitedMs(t)).toBe(4000);

    const tools = telemetryOf({
      tools: [
        { name: "bash", runs: 5, failed: 2, p50Ms: null, maxMs: null },
        { name: "edit", runs: 9, failed: 3, p50Ms: null, maxMs: null },
      ],
    });
    expect(failedTools(tools)).toBe(5);

    expect(errorRatePct(telemetryOf({ calls: { total: 0, failed: 0, rateLimited: 0 } }))).toBeNull();
    expect(errorRatePct(telemetryOf({ calls: { total: 40, failed: 2, rateLimited: 0 } }))).toBe(5);

    const s = sessionIn("working", {
      telemetry: telemetryOf({
        credits: { nanoAiu: 7, aiCredits: null },
        tokenRate: 3,
        context: { estimatePct: 40 },
        permissions: { waitedMs: 1500 },
        input: { waitedMs: 2500 },
        tools: [{ name: "bash", runs: 5, failed: 5, p50Ms: null, maxMs: null }],
      }),
    });
    expect(sortValue(s, "credits")).toBe(7);
    expect(sortValue(s, "rate")).toBe(3);
    expect(sortValue(s, "ctx")).toBe(40);
    expect(sortValue(s, "waited")).toBe(4000);
    expect(sortValue(s, "failed")).toBe(5);

    const bare = sessionIn("working", { telemetry: null });
    for (const k of ["credits", "rate", "ctx", "waited", "failed"] as const) {
      expect(sortValue(bare, k)).toBeNull();
    }
  });

  it("UR-04 route round trip for deck, session and run; bad hashes read as deck", () => {
    const deck: Route = { page: "deck" };
    const session: Route = { page: "session", id: "a/b#c%d e" };
    const run: Route = { page: "run", id: "x/y#z%", traceId: "t/1 #%" };
    for (const r of [deck, session, run]) {
      expect(parseRoute(routeHref(r))).toEqual(r);
    }
    expect(parseRoute("#/s/%E0%A4%A")).toEqual(deck);
    expect(parseRoute("#/nope")).toEqual(deck);
  });

  it("UR-05 api.traces returns the body on 200, the status on other codes, 0 on network error", async () => {
    const body = { sessionId: "a/b", runs: [] };
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => ({ status: 200, json: async () => body }));
    vi.stubGlobal("fetch", ok);
    expect(await api.traces("a/b")).toEqual(body);
    expect(ok.mock.calls[0]?.[0]).toBe("/api/sessions/a%2Fb/traces");
    expect(ok.mock.calls[0]?.[1]).toEqual({ credentials: "same-origin" });

    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, json: async () => ({}) })));
    expect(await api.traces("x")).toBe(404);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    expect(await api.traces("x")).toBe(0);
  });

  it("UR-06 the fixtures validate against the contracts", () => {
    const session = sessionIn("working", { telemetry: telemetryOf() });
    expect(validateSession(session).ok).toBe(true);

    const response = {
      sessionId: "x",
      runs: [runOf({ traceId: "t", spans: [spanOf({ spanId: "a" })] })],
    };
    expect(validateTracesResponse(response).ok).toBe(true);
  });
});
