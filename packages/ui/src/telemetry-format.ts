import type { Session, Telemetry } from "@mc/contracts";
import { age } from "./format.js";

export type Availability = "data" | "pending" | "na" | "none";

/** D-58 / DESIGN 3a: why a session has no telemetry, by adapter (claude-code has a source since D-61). */
export function availability(s: Session): Availability {
  if (s.telemetry !== null && s.telemetry !== undefined) return "data";
  if (s.adapter === "copilot-cli" || s.adapter === "claude-code") return "pending";
  if (s.adapter === "shell") return "na";
  return "none";
}

const AVAILABILITY_TEXT: Record<Exclude<Availability, "data">, string> = {
  pending: "No data yet",
  na: "n/a",
  none: "No data",
};

export function availabilityText(a: Exclude<Availability, "data">): string {
  return AVAILABILITY_TEXT[a];
}

const en = (n: number): string => n.toLocaleString("en-US");

/** Compact count: 999, 12.3k, 4.56M, 1.23B; three significant digits for k/M/B. */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return en(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toPrecision(3)}k`;
  if (n < 1e9) return `${(n / 1e6).toPrecision(3)}M`;
  return `${(n / 1e9).toPrecision(3)}B`;
}

/** Credits: AI Credits when converted, else nano-AIU, else a dash. */
export function credits(t: Telemetry): { text: string; unit: string } {
  if (t.credits.aiCredits !== null) return { text: t.credits.aiCredits.toFixed(2), unit: "AI Credits" };
  if (t.credits.nanoAiu !== null) return { text: compact(t.credits.nanoAiu), unit: "nano-AIU" };
  return { text: "—", unit: "" };
}

export function rateText(n: number): string {
  return en(Math.round(n));
}

export function contextPct(t: Telemetry): number | null {
  return t.context.estimatePct;
}

export function contextText(t: Telemetry): string {
  const pct = contextPct(t);
  return pct === null ? "—" : `≈${Math.round(pct)}%`;
}

export function contextOver(t: Telemetry): boolean {
  const pct = contextPct(t);
  return pct !== null && pct > 85;
}

/** Duration: 430 ms, 4.2 s, 3m 05s, 1h 02m. */
export function durationText(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function waitedMs(t: Telemetry): number {
  return t.permissions.waitedMs + t.input.waitedMs;
}

export function failedTools(t: Telemetry): number {
  return t.tools.reduce((sum, tool) => sum + tool.failed, 0);
}

export function errorRatePct(t: Telemetry): number | null {
  if (t.calls.total === 0) return null;
  return (100 * t.calls.failed) / t.calls.total;
}

export function ageText(iso: string, now: number): string {
  return `${age(now - Date.parse(iso))} ago`;
}

export type SortKey = "credits" | "rate" | "ctx" | "waited" | "failed";

export function sortValue(s: Session, k: SortKey): number | null {
  const t = s.telemetry;
  if (t === null || t === undefined) return null;
  switch (k) {
    case "credits":
      return t.credits.aiCredits ?? t.credits.nanoAiu ?? null;
    case "rate":
      return t.tokenRate;
    case "ctx":
      return contextPct(t);
    case "waited":
      return waitedMs(t);
    case "failed":
      return failedTools(t);
  }
}
