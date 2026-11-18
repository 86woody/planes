import type { JSX } from "react";
import type { CopilotAccount } from "@mc/contracts";
import type { BarProps } from "../model.js";
import { clock } from "../format.js";
import { Lamp } from "./Lamp.js";

/** Research note 10.2: the month's Copilot use and forecast; absent with no Copilot account data. */
export function CreditsPill(p: { account: CopilotAccount | null }): JSX.Element | null {
  const a = p.account;
  if (a === null) return null;
  const used = a.quota?.remainingPct != null ? Math.round(100 - a.quota.remainingPct) : null;
  const forecast = a.forecastPct === null ? null : Math.round(a.forecastPct);
  const today = a.aiCreditsToday;
  if (used === null && forecast === null && (today === null || today === 0)) return null;
  const parts = [
    today === null ? null : `${today.toFixed(2)} AIC today`,
    used === null ? null : `${used}% of month`,
    forecast === null ? null : `forecast ${forecast}%`,
  ].filter((x): x is string => x !== null);
  const over = forecast !== null && forecast > 100;
  return (
    <span className="credits num" data-testid="credits-pill" data-over={over ? "true" : "false"} title="Copilot AI Credits (from the Copilot SDK)">
      {parts.join(" · ")}
    </span>
  );
}

// DESIGN.md 2, the header: brand and host, the link and notify lamps, the clock, view buttons.
export function Bar(p: BarProps): JSX.Element {
  const caps = p.capabilities;
  const link = p.link === "open" ? "go" : "look";
  const notify = caps === null ? "off" : caps.notify && caps.notifyClick ? "go" : "look";
  const notifyTitle =
    caps === null
      ? "Notifications: unknown"
      : !caps.notify
        ? "Notifications are not available on this machine"
        : caps.notifyClick
          ? "Notifications on; clicking one restores its session"
          : "Notifications on, but clicking one cannot restore its session";

  return (
    <header data-testid="fd-bar" className="top">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
          <path d="M2 17c3-1 4-6 6-6s3 3 5 3 3-9 5-9 3 8 6 9" />
          <path d="M2 21h22" strokeDasharray="1.5 2.5" />
        </svg>
        <h1>Mission Control</h1>
        <span data-testid="fd-host" className="host">
          {p.hostname}
        </span>
      </div>
      <div className="tools">
        <span className="lamps">
          <span data-testid="lamp-link" data-color={link} title={link === "go" ? "Live link to the daemon" : "No link to the daemon"}>
            <Lamp color={link} />
            <span className="tx">Link</span>
          </span>
          <span data-testid="lamp-notify" data-color={notify} title={notifyTitle}>
            <Lamp color={notify} />
            <span className="tx">Notify</span>
          </span>
        </span>
        <CreditsPill account={p.daemon?.copilot ?? null} />
        <span data-testid="fd-met" className="clock num">
          {clock(p.now)}
        </span>
        <button type="button" className="tb" data-testid="btn-list" aria-pressed={p.listMode} title="List view (L)" onClick={p.onList}>
          <span className="tx">List</span>
          <kbd aria-hidden="true">L</kbd>
        </button>
        <button type="button" className="tb" data-testid="btn-telemetry" aria-pressed={p.telemetry} title="Show or hide the telemetry row (T)" onClick={p.onTelemetry}>
          <span className="tx">Telemetry</span>
          <kbd aria-hidden="true">T</kbd>
        </button>
        <button type="button" className="tb sq" data-testid="btn-theme" aria-label="Toggle theme" title="Toggle theme" onClick={p.onTheme}>
          <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 1.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
          </svg>
        </button>
        <button type="button" className="tb sq" data-testid="btn-help" aria-label="Keyboard help" title="Keys (?)" onClick={p.onHelp}>
          ?
        </button>
      </div>
    </header>
  );
}
