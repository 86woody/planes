import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceRun } from "@mc/contracts";
import { RunTrace } from "../src/components/RunTrace.js";
import { sessionIn } from "./fixtures.js";
import { runOf, spanOf } from "./telemetry-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = "2026-11-12T09:00:00.000Z";
const T0_MS = Date.parse(T0);
const at = (ms: number): string => new Date(T0_MS + ms).toISOString();
const NOW = T0_MS + 12000;

const mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(node));
  return host;
}

function trace(run: TraceRun | null, loading = false): HTMLElement {
  const session = sessionIn("working");
  return mount(<RunTrace session={session} run={run} loading={loading} now={NOW} />);
}

function sampleRun(): TraceRun {
  return runOf({
    traceId: "t-sample",
    startedAt: T0,
    durationMs: 10000,
    spans: [
      spanOf({ spanId: "root", parentSpanId: null, kind: "agent", name: "invoke_agent copilot", startedAt: at(0), durationMs: 10000 }),
      spanOf({
        spanId: "chat",
        parentSpanId: "root",
        kind: "chat",
        name: "chat claude-sonnet-5.5",
        model: "claude-sonnet-5.5",
        startedAt: at(100),
        durationMs: 4000,
        inputTokens: 1200,
        outputTokens: 300,
        ttftMs: 850,
        events: [{ name: "gen_ai.content.prompt", at: at(150) }],
      }),
      spanOf({
        spanId: "tool",
        parentSpanId: "root",
        kind: "tool",
        name: "execute_tool powershell",
        tool: "powershell",
        status: "error",
        startedAt: at(4200),
        durationMs: 300,
      }),
    ],
  });
}

const rowsOf = (host: HTMLElement): HTMLElement[] =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="rv-row"]')];

describe("RunTrace", () => {
  it("RT-03 renders one row per span with kind tags, token counts and an errored tool row", () => {
    const host = trace(sampleRun());
    const rows = rowsOf(host);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dataset.kind)).toEqual(["agent", "chat", "tool"]);
    expect(rows.map((r) => r.dataset.depth)).toEqual(["0", "1", "1"]);
    expect(rows.map((r) => r.querySelector(".rv-kind")?.textContent)).toEqual(["AG", "CH", "TL"]);
    expect(rows[1]?.querySelector(".rv-right")?.textContent).toBe("in 1,200 · out 300");
    expect(rows[2]?.dataset.status).toBe("error");
    expect(rows[2]?.textContent).toContain("Error");
  });

  it("RT-04 shows the open and dropped notes, and the missing state with a back link", () => {
    const open = trace({ ...sampleRun(), complete: false, droppedSpans: 12 });
    expect(open.querySelector('[data-testid="rv-open"]')?.textContent).toContain("Run in progress");
    expect(open.querySelector('[data-testid="rv-dropped"]')?.textContent).toBe(
      "12 spans past the 500-span limit are not shown.",
    );

    const session = sessionIn("working");
    const missing = mount(<RunTrace session={session} run={null} loading={false} now={NOW} />);
    expect(missing.querySelector('[data-testid="rv-missing"]')).not.toBeNull();
    const back = missing.querySelector<HTMLAnchorElement>('[data-testid="rv-back"]');
    expect(back?.getAttribute("href")).toBe(`#/s/${encodeURIComponent(session.id)}`);
  });

  it("RT-05 selects a row on click and moves the selection on Enter", () => {
    const host = trace(sampleRun());
    const [, chat, tool] = rowsOf(host);
    act(() => chat?.click());
    expect(chat?.getAttribute("aria-selected")).toBe("true");
    const detail = host.querySelector('[data-testid="rv-span"]');
    expect(detail?.textContent).toContain("claude-sonnet-5.5");
    expect(detail?.textContent).toContain("in 1,200 · out 300");
    expect(detail?.textContent).toContain("850 ms");
    expect(detail?.textContent).toContain("gen_ai.content.prompt");

    act(() => {
      tool?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(tool?.getAttribute("aria-selected")).toBe("true");
    expect(chat?.getAttribute("aria-selected")).toBe("false");
  });
});
