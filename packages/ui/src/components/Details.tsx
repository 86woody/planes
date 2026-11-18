import type { JSX } from "react";
import type { Session } from "@mc/contracts";
import type { BoardActions, BoardState, DeckActions } from "../model.js";
import { adapterBadge, age, capabilityWord, fixText, hms, hostBadge, resultText, signalOf, stateLabel, wait } from "../format.js";
import { needsYou, type Dismissed } from "../sort.js";
import { routeHref } from "../route.js";
import { needsWord, RestoreButton, ResultChip } from "./Card.js";

function word(s: Session, needs: boolean): string {
  return needs ? needsWord(s) : stateLabel(s);
}

/** Hidden until the terrain places it next to its peak (no flash at the corner). */
const hideUntilPlaced = (el: HTMLElement | null): void => {
  if (el && el.style.transform === "") el.style.visibility = "hidden";
};

/** DESIGN.md 3, the selected session card pinned next to its peak. */
export function Selected(p: {
  session: Session;
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  actions: BoardActions;
  deck: DeckActions;
}): JSX.Element {
  const { session: s, now } = p;
  const needs = needsYou(s, p.dismissed);
  const signal = signalOf(s);
  const result = p.board.results[s.id]?.result ?? null;
  const since = s.attention.since !== null ? Date.parse(s.attention.since) : now;
  return (
    <div
      ref={hideUntilPlaced}
      className={signal === "look" ? "selc look" : "selc"}
      data-testid="selected"
      data-session={s.id}
      role="group"
      aria-label={`Selected session ${s.callsign}`}
    >
      <div className="sc-h">
        <b>{s.callsign}</b>
        <span className="ad" title={s.adapter}>
          {adapterBadge(s.adapter)}
        </span>
        <span className={`pill ${signal === "none" ? "" : signal}`}>{word(s, needs)}</span>
      </div>
      <dl className="facts">
        {needs ? (
          <>
            <dt>Waited</dt>
            <dd className="m num">{wait(now - since)}</dd>
          </>
        ) : (
          <>
            <dt>Up</dt>
            <dd className="m num">{hms(now - Date.parse(s.startedAt))}</dd>
          </>
        )}
        <dt>Last event</dt>
        <dd title={s.lastEvent.summary}>
          {s.lastEvent.summary} · {age(now - Date.parse(s.lastEvent.at))}
        </dd>
        <dt>Branch</dt>
        <dd className="m">{s.branch ?? "—"}</dd>
      </dl>
      <div className="sc-a">
        <RestoreButton session={s} pending={p.board.pending[s.id] === true} actions={p.actions} />
        {result !== null ? (
          <ResultChip result={result} />
        ) : (
          <button type="button" className="link" data-testid="selected-details" onClick={() => p.deck.details(s.id)}>
            Details
          </button>
        )}
      </div>
    </div>
  );
}

/** DESIGN.md 3, the details sheet (I): every fact about one session and its actions. */
export function Sheet(p: {
  session: Session;
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  actions: BoardActions;
  deck: DeckActions;
  onClose(): void;
}): JSX.Element {
  const { session: s, now } = p;
  const needs = needsYou(s, p.dismissed);
  const dead = s.state === "ended" || s.state === "lost";
  const signal = signalOf(s);
  const rr = s.restore.lastResult;
  const fix = fixText(s.restore.reason, rr?.detail);
  const result = p.board.results[s.id]?.result ?? null;
  return (
    <aside className="sheet" data-testid="sheet" role="dialog" aria-modal="false" aria-labelledby="sheet-h">
      <button type="button" className="x" aria-label="Close details" onClick={p.onClose}>
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
      <h2 id="sheet-h">
        {s.callsign}
        <span className="ad" title={s.adapter}>
          {adapterBadge(s.adapter)}
        </span>
      </h2>
      <p className="sub">{s.title}</p>
      <p style={{ marginBottom: 16 }}>
        <span className={`pill ${signal === "none" ? "" : signal}`}>
          <i aria-hidden="true" />
          {word(s, needs)}
        </span>
      </p>
      {needs && s.attention.message !== null && <div className="msg">{s.attention.message}</div>}
      <dl>
        {needs && (
          <>
            <dt>Waited</dt>
            <dd className="m num">
              {wait(now - Date.parse(s.attention.since ?? s.updatedAt))}
              {s.attention.acknowledged ? " · acknowledged" : ""}
            </dd>
          </>
        )}
        <dt>Last event</dt>
        <dd>
          {s.lastEvent.summary} · {age(now - Date.parse(s.lastEvent.at))} ago
        </dd>
        <dt>Restore</dt>
        <dd>
          {capabilityWord(s)}
          {rr ? ` · last ${resultText(rr).text.toLowerCase()}` : ""}
          {fix !== "" && <div className="fix">{fix}</div>}
        </dd>
        <dt>Host</dt>
        <dd>
          {hostBadge(s.host)} · {s.host.os}
        </dd>
        <dt>Project</dt>
        <dd>{s.project}</dd>
        <dt>Branch</dt>
        <dd className="m">{s.branch ?? "—"}</dd>
        <dt>Cwd</dt>
        <dd className="m">{s.cwd}</dd>
        <dt>Uptime</dt>
        <dd className="m num">{hms(now - Date.parse(s.startedAt))}</dd>
        <dt>Activity</dt>
        <dd>
          {s.stats.prompts} prompts · {s.stats.tools} tools · {s.stats.notifications} notifications
        </dd>
        <dt>Session id</dt>
        <dd className="m">{s.id}</dd>
      </dl>
      <div className="acts">
        <RestoreButton session={s} pending={p.board.pending[s.id] === true} actions={p.actions} />
        {needs && !s.attention.acknowledged && (
          <button type="button" className="btn" onClick={() => p.actions.ack(s.id)}>
            Acknowledge<kbd aria-hidden="true">A</kbd>
          </button>
        )}
        {needs && (
          <button type="button" className="btn" onClick={() => p.deck.dismissAlert(s.id)}>
            Dismiss alert<kbd aria-hidden="true">D</kbd>
          </button>
        )}
        {dead && (
          <button type="button" className="btn" onClick={() => p.actions.dismiss(s.id)}>
            Dismiss<kbd aria-hidden="true">D</kbd>
          </button>
        )}
        <button type="button" className="btn" onClick={() => p.deck.copy(s.id)}>
          Copy cwd
        </button>
        <a className="btn" data-testid="sheet-open" href={routeHref({ page: "session", id: s.id })}>
          Open session<kbd aria-hidden="true">O</kbd>
        </a>
        {result !== null && <ResultChip result={result} />}
      </div>
    </aside>
  );
}
