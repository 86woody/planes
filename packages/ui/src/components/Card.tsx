import type { JSX, MouseEvent } from "react";
import type { FocusResult, Session } from "@mc/contracts";
import type { BoardActions, CardProps } from "../model.js";
import { adapterBadge, fixText, resultText, stateLabel, wait } from "../format.js";
import { contextOver, contextText, failedTools } from "../telemetry-format.js";
import "../card.css";

const stop = (e: MouseEvent): void => e.stopPropagation();

/** RESTORE (DESIGN.md 3): capability none copies the cwd instead and sends no focus call. */
export function RestoreButton(p: { session: Session; pending: boolean; actions: BoardActions }): JSX.Element {
  const s = p.session;
  const ended = s.state === "ended";
  const none = s.restore.capability === "none";
  const label = ended ? "Ended" : p.pending ? "Restoring…" : none ? "Copy cwd" : "Restore";
  const fix = fixText(s.restore.reason, s.restore.lastResult?.detail);
  return (
    <button
      type="button"
      data-testid="restore"
      className="btn pri"
      disabled={ended || p.pending}
      title={fix === "" ? undefined : fix}
      onClick={(e) => {
        stop(e);
        if (none) p.actions.copyCwd(s.id);
        else p.actions.restore(s.id);
      }}
    >
      {label}
      <kbd aria-hidden="true">↵</kbd>
    </button>
  );
}

export function ResultChip(p: { result: FocusResult }): JSX.Element {
  const r = resultText(p.result);
  return (
    <span data-testid="result" className={`result ${r.signal}`} role="status">
      {r.text}
    </span>
  );
}

/** The Needs you word: an idle session with done attention reads "Done · review". */
export function needsWord(s: Session): string {
  if (s.state === "error") return "Error";
  if (s.attention.reason === "done") return "Done · review";
  return stateLabel(s);
}

/** Research note 10.2: one line with credits, context and failed tools; nothing without telemetry. */
export function TeleLine(p: { session: Session }): JSX.Element | null {
  const t = p.session.telemetry;
  if (!t) return null;
  const failed = failedTools(t);
  const parts: JSX.Element[] = [];
  if (t.credits.aiCredits !== null) parts.push(<span key="c"><b>{t.credits.aiCredits.toFixed(2)}</b> credits</span>);
  if (t.context.estimatePct !== null) {
    parts.push(
      <span key="x">
        <b className={contextOver(t) ? "look" : undefined}>{contextText(t)}</b> context
      </span>,
    );
  }
  parts.push(
    <span key="f">
      <b className={failed > 0 ? "look" : undefined}>{failed}</b> failed tool{failed === 1 ? "" : "s"}
    </span>,
  );
  return (
    <p className="nc-tele" data-testid="nc-tele">
      {parts.flatMap((el, i) => (i === 0 ? [el] : [<span key={`s${i}`}> · </span>, el]))}
    </p>
  );
}

/** One card in the Needs you stack (DESIGN.md 3, card anatomy). */
export function Card(p: CardProps): JSX.Element {
  const { session: s, now, actions, deck } = p;
  const acked = s.attention.acknowledged;
  const since = s.attention.since !== null ? Date.parse(s.attention.since) : now;
  const csId = `nc-${s.id}`;
  return (
    <article
      data-testid="needs-card"
      data-session={s.id}
      data-state={s.state}
      data-attention={acked ? "acked" : "active"}
      data-highlight={p.highlighted ? "true" : undefined}
      aria-current={p.selected ? "true" : undefined}
      aria-labelledby={csId}
      className="card nc"
      onClick={() => deck.select(s.id)}
    >
      <div className="nc-top">
        <span id={csId} className="cs" data-testid="callsign">
          {s.callsign}
        </span>
        <span className="ad" title={s.adapter}>
          {adapterBadge(s.adapter)}
        </span>
        <span data-testid="state-label" className={acked ? "pill" : "pill look"} data-attention={acked ? "acked" : "active"}>
          {acked ? null : <i aria-hidden="true" />}
          {needsWord(s)}
        </span>
        <span className="w num" data-testid="waited" title="Waiting since">
          {wait(now - since)}
        </span>
      </div>
      <p className="nc-msg">{s.attention.message ?? s.lastEvent.summary}</p>
      <TeleLine session={s} />
      <div className="nc-foot">
        <RestoreButton session={s} pending={p.pending} actions={actions} />
        {p.result !== null ? (
          <ResultChip result={p.result} />
        ) : (
          <span className="where">
            {s.project}
            {s.branch !== null ? ` · ${s.branch}` : ""}
          </span>
        )}
        <button
          type="button"
          className="more"
          data-testid="more"
          aria-haspopup="menu"
          aria-expanded={p.menuOpen}
          aria-label={`More actions for ${s.callsign}`}
          title="Acknowledge (A) · Dismiss (D) · Details (I)"
          onClick={(e) => {
            stop(e);
            deck.toggleMenu(p.menuOpen ? null : s.id);
          }}
        >
          <svg width="14" height="4" viewBox="0 0 14 4" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2" r="1.4" />
            <circle cx="7" cy="2" r="1.4" />
            <circle cx="12" cy="2" r="1.4" />
          </svg>
        </button>
      </div>
      {p.menuOpen && (
        <div className="menu" role="menu" aria-label={`Actions for ${s.callsign}`} onClick={stop}>
          {!acked && (
            <button type="button" role="menuitem" data-testid="ack" onClick={() => { actions.ack(s.id); deck.toggleMenu(null); }}>
              Acknowledge<kbd aria-hidden="true">A</kbd>
            </button>
          )}
          <button type="button" role="menuitem" data-testid="dismiss-alert" onClick={() => { deck.dismissAlert(s.id); deck.toggleMenu(null); }}>
            Dismiss alert<kbd aria-hidden="true">D</kbd>
          </button>
          <button type="button" role="menuitem" data-testid="details" onClick={() => { deck.details(s.id); deck.toggleMenu(null); }}>
            Details<kbd aria-hidden="true">I</kbd>
          </button>
          <button type="button" role="menuitem" data-testid="copy-cwd" onClick={() => { deck.copy(s.id); deck.toggleMenu(null); }}>
            Copy cwd
          </button>
        </div>
      )}
    </article>
  );
}
