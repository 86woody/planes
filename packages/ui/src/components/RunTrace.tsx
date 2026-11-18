import { useState, type JSX } from "react";
import type { Session, TraceRun, TraceSpan } from "@mc/contracts";
import { routeHref } from "../route.js";
import { compact, durationText } from "../telemetry-format.js";
import { layoutRun, type TraceLayout, type TraceRow } from "../trace-layout.js";
import "../trace.css";

/** DESIGN 3a: the run trace page (`#/s/<id>/run/<traceId>`). */

const KIND_TAG: Record<TraceSpan["kind"], string> = {
  agent: "AG",
  chat: "CH",
  compaction: "CP",
  tool: "TL",
  skill: "SK",
  other: "··",
};

const STATUS_WORD: Record<TraceSpan["status"], string> = { ok: "OK", error: "Error", unset: "Unset" };

const en = (n: number | null): string => (n === null ? "—" : n.toLocaleString("en-US"));
const tokensText = (s: TraceSpan): string => `in ${en(s.inputTokens)} · out ${en(s.outputTokens)}`;
const pad = (n: number): string => String(n).padStart(2, "0");
const clockHms = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const clamp = (n: number): number => Math.min(100, Math.max(0, n));
const spanLabel = (s: TraceSpan): string => s.model ?? s.tool ?? s.name;

function runStatus(run: TraceRun): { text: string; tone: "go" | "look" | "none" } {
  if (!run.complete) return { text: "Running", tone: "none" };
  if (run.status === "error") return { text: "Error", tone: "look" };
  return { text: "OK", tone: "go" };
}

interface RowProps {
  row: TraceRow;
  selected: boolean;
  onSelect: () => void;
}

function WaterfallRow({ row, selected, onSelect }: RowProps): JSX.Element {
  const s = row.span;
  const span = row.endMs - row.startMs;
  const pctAt = (ms: number): number => (span > 0 ? clamp((100 * (ms - row.startMs)) / span) : 0);
  return (
    <div
      role="row"
      tabIndex={0}
      className="rv-row"
      data-testid="rv-row"
      data-kind={s.kind}
      data-status={s.status}
      data-depth={row.depth}
      data-orphan={row.orphan ? "true" : undefined}
      data-open={row.open ? "true" : undefined}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
    >
      <div role="gridcell" className="rv-label" style={{ paddingLeft: `${row.depth * 14}px` }}>
        <span className="rv-kind">{KIND_TAG[s.kind]}</span>
        <span className="rv-name">{spanLabel(s)}</span>
        {s.status === "error" ? <span className="rv-err">Error</span> : null}
      </div>
      <div role="gridcell" className="rv-track">
        <div className="bar" style={{ left: `${row.leftPct}%`, width: `max(2px, ${row.widthPct}%)` }}>
          {s.events.map((e, i) => (
            <i
              key={`${i}-${e.at}`}
              className="ev"
              title={`${e.name} +${durationText(Date.parse(e.at) - row.startMs)}`}
              style={{ left: `${pctAt(Date.parse(e.at))}%` }}
            />
          ))}
        </div>
      </div>
      <div role="gridcell" className="rv-right">
        {s.kind === "chat" ? tokensText(s) : durationText(s.durationMs)}
      </div>
    </div>
  );
}

function SpanDetail({ row, t0 }: { row: TraceRow; t0: number }): JSX.Element {
  const s = row.span;
  return (
    <section className="rv-span" data-testid="rv-span" aria-label="Span detail">
      <h3 className="rv-span-name">{s.name}</h3>
      <dl>
        <dt>Kind</dt>
        <dd>{s.kind}</dd>
        <dt>Status</dt>
        <dd>{STATUS_WORD[s.status]}</dd>
        <dt>Start</dt>
        <dd>{durationText(row.startMs - t0)}</dd>
        <dt>Duration</dt>
        <dd>{durationText(s.durationMs)}</dd>
        <dt>Model</dt>
        <dd>{s.model ?? "—"}</dd>
        <dt>Tool</dt>
        <dd>{s.tool ?? "—"}</dd>
        <dt>Tokens</dt>
        <dd>{tokensText(s)}</dd>
        <dt>TTFT</dt>
        <dd>{durationText(s.ttftMs)}</dd>
        <dt>Server time</dt>
        <dd>{durationText(s.serverMs)}</dd>
      </dl>
      <h4 className="rv-span-events">Events</h4>
      {s.events.length === 0 ? (
        <p className="rv-none">No events.</p>
      ) : (
        <ol>
          {s.events.map((e, i) => (
            <li key={`${i}-${e.at}`}>
              {e.name} +{durationText(Date.parse(e.at) - row.startMs)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Waterfall({ run, layout }: { run: TraceRun; layout: TraceLayout }): JSX.Element {
  return (
    <div className="rv-chart">
      {run.complete ? null : (
        <p className="rv-note" data-testid="rv-open">
          Run in progress: the agent span has not arrived yet.
        </p>
      )}
      {run.droppedSpans > 0 ? (
        <p className="rv-note" data-testid="rv-dropped">
          {`${run.droppedSpans} spans past the 500-span limit are not shown.`}
        </p>
      ) : null}
      <div className="rv-axis" aria-hidden="true">
        <span />
        <div className="rv-axis-track">
          {layout.ticks.map((t) => (
            <span key={t.pct} className="rv-tick" style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <span />
      </div>
      {/* Selection lives in the rows; the detail below reads the chosen one. */}
      <WaterfallGrid layout={layout} />
    </div>
  );
}

function WaterfallGrid({ layout }: { layout: TraceLayout }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = layout.rows.find((r) => r.span.spanId === selected) ?? null;
  return (
    <>
      <div role="grid" aria-label="Spans" data-testid="rv-waterfall" className="rv-grid">
        {layout.rows.map((row) => (
          <WaterfallRow
            key={row.span.spanId}
            row={row}
            selected={row.span.spanId === selected}
            onSelect={() => setSelected(row.span.spanId)}
          />
        ))}
      </div>
      {chosen === null ? null : <SpanDetail row={chosen} t0={layout.t0} />}
    </>
  );
}

export function RunTrace(p: { session: Session; run: TraceRun | null; loading: boolean; now: number }): JSX.Element {
  const back = (
    <a className="rv-back" data-testid="rv-back" href={routeHref({ page: "session", id: p.session.id })}>
      ← {p.session.callsign}
    </a>
  );

  if (p.run === null) {
    if (p.loading) {
      return (
        <section className="pagev" data-testid="run-view" aria-labelledby="rv-h">
          <p id="rv-h" className="rv-state">
            Loading run…
          </p>
        </section>
      );
    }
    return (
      <section className="pagev" data-testid="run-view" aria-labelledby="rv-h">
        <p id="rv-h" className="rv-state" data-testid="rv-missing">
          This run is not in the newest 50 for {p.session.callsign}.
        </p>
        {back}
      </section>
    );
  }

  const run = p.run;
  const layout = layoutRun(run, p.now);
  const status = runStatus(run);

  return (
    <section className="pagev" data-testid="run-view" aria-labelledby="rv-h">
      <header className="rv-head">
        {back}
        <h2 id="rv-h" className="rv-title">
          {`Run ${clockHms(Date.parse(run.startedAt))}`}
        </h2>
        <span className="rv-pill" data-tone={status.tone} data-testid="rv-status">
          {status.text}
        </span>
      </header>
      <dl className="rv-facts">
        <div>
          <dt>Agent</dt>
          <dd>{run.agent ?? "—"}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{durationText(run.durationMs)}</dd>
        </div>
        <div>
          <dt>Credits</dt>
          <dd>{run.nanoAiu === null ? "—" : `${compact(run.nanoAiu)} nano-AIU`}</dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{run.turnCount ?? "—"}</dd>
        </div>
        <div>
          <dt>Spans</dt>
          <dd>{`${run.spans.length} spans`}</dd>
        </div>
      </dl>
      <Waterfall run={run} layout={layout} />
    </section>
  );
}
