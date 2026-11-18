import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Telemetry, TraceRun, TracesResponse } from "@mc/contracts";
import { SessionView } from "../src/components/SessionView.js";
import { routeHref } from "../src/route.js";
import type { BoardActions, BoardState } from "../src/model.js";
import { sessionIn } from "./fixtures.js";
import { runOf, spanOf, telemetryOf } from "./telemetry-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 2026-11-12T09:01:12Z, the instant every "ago" value is measured from.
const NOW = Date.parse("2026-11-12T09:01:12.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.useRealTimers();
});

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(node));
  return host;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

function actions(): BoardActions {
  return { restore: vi.fn(), ack: vi.fn(), dismiss: vi.fn(), copyCwd: vi.fn(), pair: vi.fn(async () => true) };
}

function board(pending: Record<string, true> = {}): BoardState {
  return { link: "open", needsPairing: false, state: null, results: {}, pending, highlight: null };
}

async function view(
  session: Session,
  loadTraces: (id: string) => Promise<TracesResponse | number>,
  extra: { pending?: Record<string, true> } = {},
): Promise<HTMLElement> {
  const host = mount(
    <SessionView
      session={session}
      board={board(extra.pending ?? {})}
      now={NOW}
      actions={actions()}
      onCopy={vi.fn()}
      loadTraces={loadTraces}
    />,
  );
  await flush();
  return host;
}

const q = (el: ParentNode, id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const kpi = (el: ParentNode, k: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`[data-testid="sv-kpi"][data-k="${k}"]`);
const tracesOf = (runs: TraceRun[]): TracesResponse => ({ runs }) as TracesResponse;
const okLoader = (runs: TraceRun[]) => vi.fn(async (_id: string) => tracesOf(runs));
const copilot = (telemetry: Telemetry | null): Session => sessionIn("working", { adapter: "copilot-cli", telemetry });

describe("session page", () => {
  it("SD-01 a copilot-cli session shows six key values from telemetry and the update age", async () => {
    const t = telemetryOf({
      credits: { aiCredits: 12.35 },
      tokens: { input: 2000, output: 1000, cacheRead: 500 },
      tokenRate: 1234,
      context: { estimatePct: 42, promptTokens: 84000, maxPromptTokens: 200000 },
      calls: { total: 40, failed: 0, rateLimited: 0 },
      permissions: { waitedMs: 72000 },
    });
    const host = await view(copilot(t), okLoader([]));
    expect(host.querySelectorAll('[data-testid="sv-kpi"]').length).toBe(6);
    expect(kpi(host, "credits")?.querySelector("b")?.textContent).toBe("12.35");
    expect(kpi(host, "tokens")?.querySelector("b")?.textContent).toBe("3,000");
    expect(kpi(host, "rate")?.querySelector("b")?.textContent).toBe("1,234");
    expect(kpi(host, "ctx")?.querySelector("b")?.textContent).toBe("≈42%");
    expect(kpi(host, "calls")?.querySelector("b")?.textContent).toBe("40");
    expect(kpi(host, "waited")?.querySelector("b")?.textContent).toBe("01:12");
    expect(q(host, "sv-age")?.textContent).toContain("12s ago");
    expect(q(host, "sv-back")?.getAttribute("href")).toBe("#/");
  });

  it("SD-02 without telemetry: copilot-cli reads No data yet, shell n/a, claude-code No data, and no key values", async () => {
    const cases: [Session, string][] = [
      [copilot(null), "No data yet"],
      [sessionIn("working", { adapter: "shell", telemetry: null }), "n/a"],
      [sessionIn("working", { adapter: "claude-code", telemetry: null }), "No data"],
    ];
    for (const [session, text] of cases) {
      const host = await view(session, okLoader([]));
      expect(q(host, "sv-nodata")?.textContent, session.adapter).toContain(text);
      expect(host.querySelector('[data-testid="sv-kpi"]'), session.adapter).toBeNull();
    }
  });

  it("SD-03 context over 85 and a 7.5% error rate mark ctx and calls; a pending permission reads waiting 01:15", async () => {
    const t = telemetryOf({
      context: { estimatePct: 90, promptTokens: 180000, maxPromptTokens: 200000 },
      calls: { total: 40, failed: 3, rateLimited: 0 },
      permissions: { requested: 1, pending: 1, pendingSince: ago(75_000) },
    });
    const host = await view(copilot(t), okLoader([]));
    expect(kpi(host, "ctx")?.getAttribute("data-over")).toBe("true");
    expect(kpi(host, "ctx")?.textContent).toContain("Over 85%");
    expect(kpi(host, "calls")?.getAttribute("data-over")).toBe("true");
    expect(kpi(host, "calls")?.textContent).toContain("Error rate 8%");
    expect(kpi(host, "waited")?.textContent).toContain("waiting 01:15");
    expect(kpi(host, "waited")?.getAttribute("data-over")).toBe("true");
  });

  it("SD-04 the model-call strip draws one bar per call, the largest at 100%, with failed and model marks and a legend", async () => {
    const t = telemetryOf({
      recentCalls: [
        { at: ago(60_000), model: "claude-sonnet-5.5", input: 1000, output: 200, failed: false, subagent: false },
        { at: ago(30_000), model: "claude-haiku-5-5", input: 300, output: 0, failed: true, subagent: false },
        { at: ago(10_000), model: "claude-sonnet-5.5", input: 400, output: 100, failed: false, subagent: true },
      ],
    });
    const host = await view(copilot(t), okLoader([]));
    const bars = host.querySelectorAll<HTMLElement>('[data-testid="sv-calls"] > i.bar');
    expect(bars.length).toBe(3);
    expect(bars[0]?.style.height).toBe("100%");
    expect(bars[1]?.getAttribute("data-failed")).toBe("true");
    expect(bars[2]?.getAttribute("data-sub")).toBe("true");
    expect(bars[0]?.getAttribute("data-model")).toBe("0");
    expect(bars[1]?.getAttribute("data-model")).toBe("1");
    const legend = q(host, "sv-legend")?.textContent ?? "";
    expect(legend).toContain("claude-sonnet-5.5");
    expect(legend).toContain("claude-haiku-5-5");
  });

  it("SD-05 runs render newest first with links, span counts and status, refresh every 5 s while live, and keep the last good answer", async () => {
    vi.useFakeTimers();
    const session = copilot(telemetryOf());
    const runA = runOf({
      traceId: "r1",
      startedAt: "2026-11-12T08:50:00.000Z",
      spans: [
        spanOf({ spanId: "a", kind: "chat", inputTokens: 100, outputTokens: 50 }),
        spanOf({ spanId: "b", kind: "chat", inputTokens: 10, outputTokens: 5 }),
        spanOf({ spanId: "c", kind: "tool", tool: "bash" }),
        spanOf({ spanId: "d", kind: "skill" }),
      ],
    });
    const runB = runOf({ traceId: "r2", startedAt: "2026-11-12T08:55:00.000Z", complete: false });
    const runC = runOf({ traceId: "r3", startedAt: "2026-11-12T09:00:00.000Z", status: "error" });
    const loader = vi
      .fn<(id: string) => Promise<TracesResponse | number>>()
      .mockResolvedValueOnce(tracesOf([runA, runB, runC]))
      .mockResolvedValue(500);
    const host = await view(session, loader);

    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="sv-run"]')];
    expect(rows.map((r) => r.getAttribute("data-trace"))).toEqual(["r3", "r2", "r1"]);
    const link = rows[2]?.querySelector("a");
    expect(link?.getAttribute("href")).toBe(routeHref({ page: "run", id: session.id, traceId: "r1" }));
    const cells = rows[2]?.querySelectorAll("td") ?? [];
    expect(cells[3]?.textContent).toBe("2");
    expect(cells[4]?.textContent).toBe("2");
    expect(rows[1]?.textContent).toContain("Running");
    expect(rows[0]?.textContent).toContain("Error");

    // Live session: a 5 s refresh. The 500 that follows does not replace the good rows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-testid="sv-run"]').length).toBe(3);
    expect(host.textContent).not.toContain("Could not load runs");

    // An ended session is not polled.
    const ended = sessionIn("ended", { telemetry: telemetryOf() });
    const endedLoader = okLoader([]);
    await view(ended, endedLoader);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(endedLoader).toHaveBeenCalledTimes(1);

    const failing = await view(copilot(telemetryOf()), vi.fn(async () => 500));
    expect(failing.textContent).toContain("Could not load runs (500)");

    const empty = await view(copilot(telemetryOf()), okLoader([]));
    expect(empty.textContent).toContain("No traces yet");
  });

  it("SD-06 tools sort by runs with failures marked; subagents are hidden when empty and show ≠ parent when the model differs", async () => {
    const t = telemetryOf({
      tools: [
        { name: "bash", runs: 3, failed: 0, p50Ms: 400, maxMs: 900 },
        { name: "edit", runs: 5, failed: 2, p50Ms: 120, maxMs: 700 },
      ],
    });
    const host = await view(copilot(t), okLoader([]));
    const toolRows = host.querySelectorAll<HTMLElement>('[data-testid="sv-tools"] tbody tr');
    expect(toolRows[0]?.textContent).toContain("edit");
    expect(toolRows[1]?.textContent).toContain("bash");
    expect(toolRows[0]?.querySelector("td[data-over]")).not.toBeNull();
    expect(toolRows[1]?.querySelector("td[data-over]")).toBeNull();
    expect(q(host, "sv-subs")).toBeNull();

    const withSub = telemetryOf({
      subagents: [{ name: "explore", model: "claude-haiku-5-5", durationMs: 4200, failed: false, modelMatches: false }],
    });
    const host2 = await view(copilot(withSub), okLoader([]));
    expect(q(host2, "sv-subs")?.textContent).toContain("≠ parent");
  });
});
