import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CopilotAccount, Session } from "@mc/contracts";
import { cardValues, Telemetry } from "../src/components/Telemetry.js";
import { CreditsPill } from "../src/components/Bar.js";
import { TeleLine } from "../src/components/Card.js";
import { sessionIn } from "./fixtures.js";
import { telemetryOf } from "./telemetry-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D-61: the four board cards, the header pill and the Needs you line read real telemetry only.
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const fresh = new Date(NOW - 3000).toISOString();

const cc = (id: string, callsign: string, patch: Parameters<typeof telemetryOf>[0]): Session =>
  sessionIn("working", { id, callsign, adapter: "claude-code", telemetry: telemetryOf({ updatedAt: fresh, ...patch }) });

const account = (patch: Partial<CopilotAccount> = {}): CopilotAccount => ({
  updatedAt: fresh,
  runtimeVersion: "1.0.112",
  planTier: "pro",
  quota: { entitlement: 300, used: 120, remainingPct: 60, resetDate: "2026-12-01T00:00:00Z", unlimited: false },
  nanoAiuToday: 2_500_000_000,
  aiCreditsToday: 2.5,
  forecastPct: 92,
  error: null,
  ...patch,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(el: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(el));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("telemetry cards on real data (D-61)", () => {
  it("TC-01 the fleet: summed token rate with the busiest session, the fullest context with ≈ and Over 85%, the error rate, the age pill; no sample text", () => {
    const a = cc("a", "MC-01", { tokenRate: 1200, context: { estimatePct: 40, promptTokens: 80_000, maxPromptTokens: 200_000 }, calls: { total: 10, failed: 1 } });
    const b = cc("b", "MC-02", { tokenRate: 3400, context: { estimatePct: 91, promptTokens: 182_000, maxPromptTokens: 200_000 }, calls: { total: 10, failed: 0 }, errors: { count: 1, lastType: "rate_limit_error" } });
    const ended = sessionIn("ended", { id: "z", telemetry: telemetryOf({ tokenRate: 99_999 }) });
    const v = cardValues([a, b, ended], null, null, NOW);
    expect(v.tok).toMatchObject({ v: 4600, text: "4,600", sub: "tok/min · busiest MC-02", pill: "3s ago" });
    expect(v.ctx).toMatchObject({ v: 91, text: "≈91", over: true, pill: "Over 85%" });
    expect(v.ctx.sub).toContain("MC-02");
    expect(v.err).toMatchObject({ v: 5, text: "5.0", over: false, sub: "% · last rate_limit_error" });
    const el = render(<Telemetry sessions={[a, b]} selected={null} account={null} now={NOW} />);
    expect(el.querySelector('[data-testid="telemetry"]')?.getAttribute("data-mode")).toBe("live");
    expect(el.textContent).not.toMatch(/sample/i);
    expect(el.querySelectorAll(".tc.over")).toHaveLength(1);
  });

  it("TC-02 no source reads No data, n/a or No data yet and shows no number; credits are Copilot only", () => {
    const shell = sessionIn("working", { id: "sh", adapter: "shell", telemetry: null });
    const waiting = sessionIn("working", { id: "c", adapter: "claude-code", telemetry: null });
    expect(cardValues([shell], shell, null, NOW).tok).toMatchObject({ v: null, pill: "n/a", sub: "n/a" });
    expect(cardValues([waiting], waiting, null, NOW).tok).toMatchObject({ v: null, pill: "No data", sub: "No data yet" });
    expect(cardValues([], null, null, NOW).tok.sub).toBe("No live sessions");
    const withTel = cc("a", "MC-01", { tokenRate: 10 });
    expect(cardValues([withTel], withTel, null, NOW).cred).toMatchObject({ v: null, sub: "Copilot sessions only" });
    const el = render(<Telemetry sessions={[shell]} selected={null} account={null} now={NOW} />);
    expect(el.querySelector('[data-testid="telemetry"]')?.getAttribute("data-mode")).toBe("wait");
    expect(el.querySelectorAll(".tc.nodata")).toHaveLength(4);
  });

  it("TC-03 AI Credits: the fleet reads the daemon's day total and month use; a session its own credits; a forecast over 100% warns", () => {
    const cp = sessionIn("working", { id: "p", adapter: "copilot-cli", telemetry: telemetryOf({ updatedAt: fresh, credits: { nanoAiu: 1_250_000_000, aiCredits: 1.25 } }) });
    expect(cardValues([cp], null, account(), NOW).cred).toMatchObject({ v: 2.5, text: "2.50", sub: "today · 40% of month · forecast 92%", over: false });
    expect(cardValues([cp], cp, account(), NOW).cred).toMatchObject({ v: 1.25, text: "1.25" });
    expect(cardValues([cp], null, account({ forecastPct: 130 }), NOW).cred).toMatchObject({ over: true, pill: "Forecast over 100%" });
  });

  it("TC-04 the header pill shows credits today, month use and forecast, and hides without account data", () => {
    let el = render(<CreditsPill account={account({ forecastPct: 130 })} />);
    const pill = el.querySelector('[data-testid="credits-pill"]');
    expect(pill?.textContent).toBe("2.50 AIC today · 40% of month · forecast 130%");
    expect(pill?.getAttribute("data-over")).toBe("true");
    act(() => root?.unmount());
    el = render(<CreditsPill account={null} />);
    expect(el.querySelector('[data-testid="credits-pill"]')).toBeNull();
  });

  it("TC-05 a Needs you card gets one line: credits, context and failed tools; none without telemetry", () => {
    const s = sessionIn("needs_permission", {
      adapter: "copilot-cli",
      telemetry: telemetryOf({ credits: { nanoAiu: 3e9, aiCredits: 3 }, context: { estimatePct: 88, promptTokens: 1, maxPromptTokens: 2 }, tools: [{ name: "bash", runs: 3, failed: 2, p50Ms: 1, maxMs: 2 }] }),
    });
    let el = render(<TeleLine session={s} />);
    expect(el.querySelector('[data-testid="nc-tele"]')?.textContent).toBe("3.00 credits · ≈88% context · 2 failed tools");
    act(() => root?.unmount());
    el = render(<TeleLine session={sessionIn("needs_permission", { telemetry: null })} />);
    expect(el.querySelector('[data-testid="nc-tele"]')).toBeNull();
  });
});
