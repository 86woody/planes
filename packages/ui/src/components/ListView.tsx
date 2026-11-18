import { useState, type JSX } from "react";
import type { Session } from "@mc/contracts";
import type { BoardActions, BoardState, DeckActions } from "../model.js";
import { adapterBadge, age, capabilityWord, fixText, hms, hostBadge, signalOf, stateLabel, wait } from "../format.js";
import { needsYou, sortSessions, type Dismissed } from "../sort.js";
import { routeHref } from "../route.js";
import {
  availability,
  availabilityText,
  contextOver,
  contextText,
  credits,
  failedTools,
  rateText,
  sortValue,
  waitedMs,
  type SortKey,
} from "../telemetry-format.js";
import { RestoreButton, ResultChip } from "./Card.js";
import "../list-tele.css";

type Sort = { key: SortKey; dir: "desc" | "asc" };

const SORT_LABEL: Record<SortKey, string> = {
  credits: "Credits",
  rate: "Tok/min",
  ctx: "Context",
  waited: "Waited on you",
  failed: "Failed tools",
};

const TELE_COLUMNS: { key: SortKey; cls: string }[] = [
  { key: "credits", cls: "ht" },
  { key: "rate", cls: "ht" },
  { key: "ctx", cls: "hw ht" },
  { key: "waited", cls: "hw ht" },
  { key: "failed", cls: "hw ht" },
];

// null -> desc -> asc -> null for the same key; another key starts at desc.
function nextSort(cur: Sort | null, key: SortKey): Sort | null {
  if (cur === null || cur.key !== key) return { key, dir: "desc" };
  return cur.dir === "desc" ? { key, dir: "asc" } : null;
}

function TeleCells({ s }: { s: Session }): JSX.Element {
  const t = s.telemetry;
  if (!t) {
    const a = availability(s);
    const text = availabilityText(a === "data" ? "none" : a);
    return (
      <>
        {TELE_COLUMNS.map((c) => (
          <td key={c.key} className={`num mono na ${c.cls}`} data-testid={`t-${c.key}`}>
            {text}
          </td>
        ))}
      </>
    );
  }
  const c = credits(t);
  const ctxOver = contextOver(t);
  const failed = failedTools(t);
  return (
    <>
      <td className="num mono ht" data-testid="t-credits">
        {c.text}
        {c.unit !== "" && (
          <>
            {" "}
            <small>{c.unit}</small>
          </>
        )}
      </td>
      <td className="num mono ht" data-testid="t-rate">
        {rateText(t.tokenRate)}
      </td>
      <td className={`num mono hw ht${ctxOver ? " over" : ""}`} data-testid="t-ctx" data-over={ctxOver ? "true" : undefined}>
        {contextText(t)}
        {ctxOver && <span className="sr-only"> Over 85%</span>}
      </td>
      <td className="num mono hw ht" data-testid="t-waited">
        {wait(waitedMs(t))}
      </td>
      <td className={`num mono hw ht${failed > 0 ? " over" : ""}`} data-testid="t-failed" data-over={failed > 0 ? "true" : undefined}>
        {failed}
      </td>
    </>
  );
}

function Row(p: {
  s: Session;
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  selected: boolean;
  actions: BoardActions;
  deck: DeckActions;
}): JSX.Element {
  const { s, now } = p;
  const dead = s.state === "ended" || s.state === "lost";
  const needs = needsYou(s, p.dismissed);
  const unacked = s.attention.active && !s.attention.acknowledged && !dead;
  const attention = !s.attention.active || dead ? "none" : s.attention.acknowledged ? "acked" : "active";
  const signal = signalOf(s);
  const since = s.attention.since !== null ? Date.parse(s.attention.since) : now;
  const result = p.board.results[s.id]?.result ?? null;
  const fix = fixText(s.restore.reason, s.restore.lastResult?.detail);
  const csId = `row-${s.id}`;
  const lastText =
    needs && s.attention.message !== null ? s.attention.message : `${s.lastEvent.summary} · ${age(now - Date.parse(s.lastEvent.at))}`;
  return (
    <tr
      data-testid="card"
      data-session={s.id}
      data-state={s.state}
      data-attention={attention}
      data-highlight={p.board.highlight === s.id ? "true" : undefined}
      aria-current={p.selected ? "true" : undefined}
      aria-labelledby={csId}
      className={dead ? "dead" : undefined}
      onClick={() => p.deck.select(s.id)}
    >
      <td>
        <span id={csId} className="m" data-testid="callsign">
          {s.callsign}
        </span>{" "}
        <span className="ad" title={s.adapter}>
          {adapterBadge(s.adapter)}
        </span>
        <div className="sub" data-testid="host">
          {hostBadge(s.host)}
        </div>
      </td>
      <td>
        <span data-testid="state-label" className={`pill ${signal === "none" ? "" : signal}`} data-attention={attention}>
          {unacked ? <i aria-hidden="true" /> : null}
          {stateLabel(s)}
        </span>
      </td>
      <td className="num mono" data-testid="elapsed">
        {needs ? wait(now - since) : hms(now - Date.parse(s.startedAt))}
      </td>
      <TeleCells s={s} />
      <td className="hm">
        <span data-testid="project">{s.project}</span>
        {s.branch !== null && (
          <div className="sub mono" data-testid="branch">
            {s.branch}
          </div>
        )}
      </td>
      <td className="wrapc hm" data-testid="last" title={lastText}>
        {lastText}
      </td>
      <td className="hm hr">
        <span data-testid="capability" title={fix === "" ? undefined : fix}>
          {capabilityWord(s)}
        </span>
        {result !== null && (
          <div className="sub">
            <ResultChip result={result} />
          </div>
        )}
      </td>
      <td className="acts">
        {!dead && (
          <a
            className="btn"
            data-testid="open-session"
            href={routeHref({ page: "session", id: s.id })}
            onClick={(e) => e.stopPropagation()}
          >
            Open
          </a>
        )}
        <RestoreButton session={s} pending={p.board.pending[s.id] === true} actions={p.actions} />
        {unacked && (
          <button
            type="button"
            className="btn"
            data-testid="ack"
            onClick={(e) => {
              e.stopPropagation();
              p.actions.ack(s.id);
            }}
          >
            Acknowledge
          </button>
        )}
        {dead && (
          <button
            type="button"
            className="btn"
            data-testid="dismiss"
            onClick={(e) => {
              e.stopPropagation();
              p.actions.dismiss(s.id);
            }}
          >
            Dismiss
          </button>
        )}
      </td>
    </tr>
  );
}

/** DESIGN.md 3, the list view (L): every session, ended and lost grouped and collapsible. */
export function ListView(p: {
  sessions: Session[];
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  selected: string | null;
  showEnded: boolean;
  onToggleEnded(): void;
  actions: BoardActions;
  deck: DeckActions;
}): JSX.Element {
  const [sort, setSort] = useState<Sort | null>(null);
  const { live, splashdown } = sortSessions(p.sessions);
  const byWhoNeeds = [...live].sort((a, b) => Number(needsYou(b, p.dismissed)) - Number(needsYou(a, p.dismissed)));
  const ordered =
    sort === null
      ? byWhoNeeds
      : [...byWhoNeeds].sort((a, b) => {
          const va = sortValue(a, sort.key);
          const vb = sortValue(b, sort.key);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return sort.dir === "desc" ? vb - va : va - vb;
        });
  const headerOrder =
    sort === null ? "sorted by who needs you" : `sorted by ${SORT_LABEL[sort.key]} ${sort.dir === "desc" ? "↓" : "↑"}`;
  const row = (s: Session): JSX.Element => (
    <Row key={s.id} s={s} board={p.board} dismissed={p.dismissed} now={p.now} selected={p.selected === s.id} actions={p.actions} deck={p.deck} />
  );
  return (
    <div className="listv" data-testid="list">
      <h2>
        All sessions
        <span>{`${p.sessions.length} · ${headerOrder} · L to close`}</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">State</th>
            <th scope="col">Waited / up</th>
            {TELE_COLUMNS.map((c) => {
              const dirState = sort?.key === c.key ? (sort.dir === "desc" ? "descending" : "ascending") : "none";
              return (
                <th key={c.key} scope="col" className={c.cls} aria-sort={dirState}>
                  <button type="button" className="sorth" data-testid={`sort-${c.key}`} onClick={() => setSort(nextSort(sort, c.key))}>
                    {SORT_LABEL[c.key]}
                  </button>
                </th>
              );
            })}
            <th scope="col" className="hm">Project</th>
            <th scope="col" className="hm">Attention / last event</th>
            <th scope="col" className="hm hr">Restore</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{ordered.map(row)}</tbody>
        {splashdown.length > 0 && (
          <tbody data-testid="splashdown">
            <tr className="grp">
              <td colSpan={12}>
                <span>Ended and lost · {splashdown.length}</span>
                <button type="button" className="link" data-testid="splashdown-toggle" aria-expanded={p.showEnded} onClick={p.onToggleEnded}>
                  {p.showEnded ? "Hide" : "Show"}
                </button>
              </td>
            </tr>
            {p.showEnded && splashdown.map(row)}
          </tbody>
        )}
      </table>
      {p.sessions.length === 0 && <p className="sub" style={{ margin: "14px 4px" }}>No sessions yet.</p>}
    </div>
  );
}
