import { describe, expect, it } from "vitest";
import { layoutRun } from "../src/trace-layout.js";
import { runOf, spanOf } from "./telemetry-fixtures.js";

const T0 = "2026-11-12T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const at = (ms: number): string => new Date(T0_MS + ms).toISOString();

describe("layoutRun", () => {
  it("RT-01 orders the tree depth-first and places spans by time", () => {
    const run = runOf({
      traceId: "t1",
      startedAt: T0,
      durationMs: 10000,
      spans: [
        spanOf({ spanId: "root", parentSpanId: null, kind: "agent", name: "invoke_agent", startedAt: at(0), durationMs: 10000 }),
        spanOf({ spanId: "chat1", parentSpanId: "root", kind: "chat", startedAt: at(0), durationMs: 2000 }),
        spanOf({ spanId: "chat2", parentSpanId: "root", kind: "chat", startedAt: at(2500), durationMs: 1000 }),
        spanOf({ spanId: "tool", parentSpanId: "chat2", kind: "tool", name: "execute_tool", startedAt: at(2600), durationMs: 300 }),
      ],
    });
    const layout = layoutRun(run, T0_MS + 10000);
    expect(layout.rows.map((r) => r.span.spanId)).toEqual(["root", "chat1", "chat2", "tool"]);
    expect(layout.rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
    expect(layout.rows.every((r) => !r.orphan && !r.open)).toBe(true);
    const chat2 = layout.rows[2];
    expect(chat2?.leftPct).toBe(25);
    expect(chat2?.widthPct).toBe(10);
    expect(layout.ticks.map((t) => t.label)).toEqual(["0 ms", "2.5 s", "5.0 s", "7.5 s", "10.0 s"]);
  });

  it("RT-02 lays out an incomplete run as orphans, ends open spans at now, and survives a cycle", () => {
    const now = T0_MS + 3000;
    const run = runOf({
      traceId: "t2",
      complete: false,
      spans: [
        spanOf({ spanId: "a", parentSpanId: "gone", startedAt: at(0), durationMs: 1000 }),
        spanOf({ spanId: "b", parentSpanId: "gone", startedAt: at(500), durationMs: null }),
        spanOf({ spanId: "x", parentSpanId: "y", startedAt: at(2000), durationMs: 100 }),
        spanOf({ spanId: "y", parentSpanId: "x", startedAt: at(2100), durationMs: 100 }),
      ],
    });
    const layout = layoutRun(run, now);
    const ids = layout.rows.map((r) => r.span.spanId);
    expect(ids).toEqual(["a", "b", "x", "y"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.rows.slice(0, 3).every((r) => r.depth === 0 && r.orphan)).toBe(true);
    const b = layout.rows[1];
    expect(b?.open).toBe(true);
    expect(b?.endMs).toBe(now);
    expect(b?.leftPct).toBeCloseTo(100 / 6, 5);
    expect(b?.widthPct).toBeCloseTo(250 / 3, 5);
  });
});
