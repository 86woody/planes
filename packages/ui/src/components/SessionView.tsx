import { useEffect, useRef, useState, type JSX } from "react";
import type { Session, Telemetry, TraceRun, TracesResponse } from "@mc/contracts";
import { api } from "../api.js";
import { adapterBadge, signalOf, stateLabel, wait } from "../format.js";
import { routeHref } from "../route.js";
import type { BoardActions, BoardState } from "../model.js";
import { RestoreButton } from "./Card.js";
import {
  ageText,
  availability,
  availabilityText,
  compact,
  contextOver,
  contextText,
  credits,
  durationText,
  errorRatePct,
  rateText,
  waitedMs,
} from "../telemetry-format.js";
import "../session-view.css";

export type TracesLoader = (id: string) => Promise<TracesResponse | number>;

interface RunsState {
  id: string;
  data: TracesResponse | null;
  status: number | null;
}

const en = (n: number): string => n.toLocaleString("en-US");
const pad2 = (n: number): string => String(n).padStart(2, "0");
const clockSec = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const isLive = (s: Session): boolean => s.state !== "ended" && s.state !== "lost";

function Kpi(p: { k: string; label: string; value: string; small: string; over?: boolean }): JSX.Element {
  return (
    <article
      className={p.over ? "kpi over" : "kpi"}
      data-testid="sv-kpi"
      data-k={p.k}
      data-over={p.over ? "true" : undefined}
    >
      <h3>{p.label}</h3>
      <b className="num">{p.value}</b>
      <small>{p.small}</small>
    </article>
  );
}

function KeyValues({ t, now }: { t: Telemetry; now: number }): JSX.Element {
  const cr = credits(t);
  const inTok = t.tokens.input;
  const outTok = t.tokens.output;
  const errRate = errorRatePct(t);
  const callsOver = errRate !== null && errRate > 5;
  const ctxOver = contextOver(t);
  const pending = t.permissions.pendingSince ?? t.input.pendingSince;
  const waitedOver = pending !== null;
  const pendingMs = pending !== null ? now - Date.parse(pending) : 0;
  const maxPrompt = t.context.maxPromptTokens;
  const promptTokens = t.context.promptTokens;
  return (
    <div className="kpis">
      <Kpi k="credits" label="AI Credits" value={cr.text} small={cr.unit || "—"} />
      <Kpi
        k="tokens"
        label="Tokens"
        value={en(inTok + outTok)}
        small={`${compact(inTok)} in · ${compact(outTok)} out · ${compact(t.tokens.cacheRead)} cache read`}
      />
      <Kpi k="rate" label="Tokens per min" value={rateText(t.tokenRate)} small="tokens per minute" />
      <Kpi
        k="ctx"
        label="Context"
        value={contextText(t)}
        over={ctxOver}
        small={ctxOver ? "Over 85%" : promptTokens !== null && maxPrompt !== null ? `${compact(promptTokens)} / ${compact(maxPrompt)}` : "—"}
      />
      <Kpi
        k="calls"
        label="Model calls"
        value={en(t.calls.total)}
        over={callsOver}
        small={
          callsOver && errRate !== null
            ? `Error rate ${Math.round(errRate)}%`
            : `${t.calls.failed} failed · ${t.calls.rateLimited} rate-limited`
        }
      />
      <Kpi
        k="waited"
        label="Waited on you"
        value={wait(waitedMs(t))}
        over={waitedOver}
        small={waitedOver ? `waiting ${wait(pendingMs)}` : `${t.permissions.requested} permission · ${t.input.requested} input`}
      />
    </div>
  );
}

const UNKNOWN_MODEL = "unknown model";

function CallStrip({ t }: { t: Telemetry }): JSX.Element {
  const calls = t.recentCalls;
  const order = new Map<string, number>();
  for (const c of calls) {
    const m = c.model ?? UNKNOWN_MODEL;
    if (!order.has(m)) order.set(m, order.size);
  }
  const totals = calls.map((c) => c.input + c.output);
  const max = Math.max(0, ...totals);
  return (
    <section className="sv-sec" aria-label="Model calls">
      <h3>Model calls</h3>
      {calls.length === 0 ? (
        <p className="sv-muted">No model calls yet.</p>
      ) : (
        <>
          <div className="sv-calls" data-testid="sv-calls">
            {calls.map((c, i) => {
              const m = c.model ?? UNKNOWN_MODEL;
              const idx = order.get(m) ?? 0;
              const total = totals[i] ?? 0;
              const h = max > 0 ? Math.max(4, Math.round((100 * total) / max)) : 4;
              return (
                <i
                  key={i}
                  className="bar"
                  data-model={String(Math.min(idx, 4))}
                  data-failed={c.failed ? "true" : undefined}
                  data-sub={c.subagent ? "true" : undefined}
                  title={`${m} · in ${en(c.input)} · out ${en(c.output)}`}
                  style={{ height: `${h}%` }}
                />
              );
            })}
          </div>
          <div className="sv-legend" data-testid="sv-legend">
            {[...order.entries()].map(([model, idx]) => (
              <span key={model} className="sv-leg">
                <i className="sw" data-model={String(Math.min(idx, 4))} />
                {model}
              </span>
            ))}
          </div>
          <p className="sv-muted">{`${calls.length} calls · ${calls.filter((c) => c.failed).length} failed`}</p>
        </>
      )}
    </section>
  );
}

function RunsTable(p: {
  session: Session;
  now: number;
  runs: RunsState;
}): JSX.Element {
  const { session, now, runs } = p;
  if (runs.data === null && runs.status === null) {
    return <p className="sv-muted">Loading runs…</p>;
  }
  if (runs.data === null) {
    return <p className="sv-muted">{`Could not load runs (${runs.status})`}</p>;
  }
  const list: TraceRun[] = runs.data.runs;
  if (list.length === 0) {
    return (
      <p className="sv-muted">
        No traces yet. Traces come from the Copilot OTel file: <code>mc install shell</code>, or the VS Code otel
        settings.
      </p>
    );
  }
  const newestFirst = [...list].reverse();
  return (
    <table className="sv-table">
      <thead>
        <tr>
          <th>Started</th>
          <th>Agent</th>
          <th className="num">Duration</th>
          <th className="num">Model calls</th>
          <th className="num">Tools</th>
          <th className="num">Tokens</th>
          <th className="num">Credits</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {newestFirst.map((run) => {
          const chat = run.spans.filter((s) => s.kind === "chat");
          const tools = run.spans.filter((s) => s.kind === "tool" || s.kind === "skill");
          const tokens = chat.reduce((sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0), 0);
          // Spans carry tokens as inputTokens/outputTokens (TraceSpan); see typecheck.
          const dur = run.complete ? durationText(run.durationMs) : durationText(now - Date.parse(run.startedAt));
          const status = !run.complete ? "Running" : run.status === "error" ? "Error" : "OK";
          const pillClass = status === "OK" ? "pill go" : status === "Error" ? "pill look" : "pill";
          return (
            <tr key={run.traceId} data-testid="sv-run" data-trace={run.traceId}>
              <td>
                <a href={routeHref({ page: "run", id: session.id, traceId: run.traceId })}>{clockSec(run.startedAt)}</a>
              </td>
              <td>{run.agent}</td>
              <td className="num">{dur}</td>
              <td className="num">{chat.length}</td>
              <td className="num">{tools.length}</td>
              <td className="num">{en(tokens)}</td>
              <td className="num">{run.nanoAiu !== null ? compact(run.nanoAiu) : "—"}</td>
              <td>
                <span className={pillClass}>{status}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ToolsTable({ t }: { t: Telemetry }): JSX.Element | null {
  if (t.tools.length === 0) return null;
  const rows = [...t.tools].sort((a, b) => b.runs - a.runs);
  return (
    <section className="sv-sec" aria-label="Tools" data-testid="sv-tools">
      <h3>Tools</h3>
      <table className="sv-table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Runs</th>
            <th className="num">Failed</th>
            <th className="num">p50</th>
            <th className="num">Max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tool) => (
            <tr key={tool.name}>
              <td>{tool.name}</td>
              <td className="num">{en(tool.runs)}</td>
              <td className={tool.failed > 0 ? "num over" : "num"} data-over={tool.failed > 0 ? "true" : undefined}>
                {en(tool.failed)}
              </td>
              <td className="num">{durationText(tool.p50Ms)}</td>
              <td className="num">{durationText(tool.maxMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PermsAndInput({ t, now }: { t: Telemetry; now: number }): JSX.Element {
  const pendingPerm = t.permissions.pendingSince;
  const pendingInput = t.input.pendingSince;
  return (
    <section className="sv-sec" aria-label="Permissions and input" data-testid="sv-perms">
      <h3>Permissions and input</h3>
      <table className="sv-table">
        <tbody>
          <tr>
            <td>Permissions</td>
            <td className="num">{`${en(t.permissions.requested)} requested · ${en(t.permissions.approved)} approved · ${en(t.permissions.denied)} denied · ${en(t.permissions.pending)} pending`}</td>
            <td className="num">{wait(t.permissions.waitedMs)}</td>
            <td className={pendingPerm !== null ? "over" : undefined}>
              {pendingPerm !== null ? `waiting ${wait(now - Date.parse(pendingPerm))}` : ""}
            </td>
          </tr>
          <tr>
            <td>Input</td>
            <td className="num">{`${en(t.input.requested)} requested`}</td>
            <td className="num">{wait(t.input.waitedMs)}</td>
            <td className={pendingInput !== null ? "over" : undefined}>
              {pendingInput !== null ? `waiting ${wait(now - Date.parse(pendingInput))}` : ""}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Subagents({ t }: { t: Telemetry }): JSX.Element | null {
  if (t.subagents.length === 0) return null;
  return (
    <section className="sv-sec" aria-label="Subagents" data-testid="sv-subs">
      <h3>Subagents</h3>
      <table className="sv-table">
        <tbody>
          {t.subagents.map((sub, i) => (
            <tr key={`${sub.name}-${i}`}>
              <td>{sub.name}</td>
              <td>
                {sub.model}
                {sub.modelMatches === false ? <span className="sv-muted"> ≠ parent</span> : null}
              </td>
              <td className="num">{durationText(sub.durationMs)}</td>
              <td>{sub.failed ? <span className="pill look">Failed</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Facts({ t }: { t: Telemetry }): JSX.Element {
  const dash = (v: number | null | undefined | string): string =>
    v === null || v === undefined || v === 0 || v === "" ? "—" : String(v);
  const cc = t.codeChanges;
  const items: [string, string][] = [
    ["Compactions", t.compaction.count === 0 ? "—" : `${en(t.compaction.count)}${t.compaction.tokens ? ` · ${compact(t.compaction.tokens)} tokens` : ""}`],
    ["Rewinds", dash(t.rewinds)],
    ["Truncations", dash(t.truncations)],
    ["Warnings", dash(t.warnings)],
    ["Code changes", cc ? `+${en(cc.linesAdded)} −${en(cc.linesRemoved)}` : "—"],
    ["Task outcome", t.task?.outcome ?? "—"],
    ["Last error", t.errors.lastType ?? "—"],
  ];
  return (
    <section className="sv-sec" aria-label="Session facts" data-testid="sv-facts">
      <dl className="sv-facts">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** DESIGN.md 3a, the session page: one session's telemetry on one full-width card. */
export function SessionView(p: {
  session: Session;
  board: BoardState;
  now: number;
  actions: BoardActions;
  onCopy(id: string): void;
  loadTraces?: (id: string) => Promise<TracesResponse | number>;
}): JSX.Element {
  const { session: s, board, now, actions, onCopy } = p;
  const loader: TracesLoader = p.loadTraces ?? api.traces;
  const loaderRef = useRef<TracesLoader>(loader);
  loaderRef.current = loader;
  const live = isLive(s);

  const [runsState, setRuns] = useState<RunsState>({ id: s.id, data: null, status: null });

  const hasTelemetry = s.telemetry !== null && s.telemetry !== undefined;
  useEffect(() => {
    // No telemetry: the runs section is not shown, so do not ask for traces.
    if (!hasTelemetry) return;
    let alive = true;
    const load = (): void => {
      void loaderRef.current(s.id).then((r) => {
        if (!alive) return;
        setRuns((prev) => {
          if (typeof r !== "number") return { id: s.id, data: r, status: null };
          // Keep the last good answer; the failure line shows only when there never was one.
          if (prev.id === s.id && prev.data !== null) return prev;
          return { id: s.id, data: null, status: r };
        });
      });
    };
    load();
    const timer = live ? setInterval(load, 5000) : undefined;
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [s.id, live, hasTelemetry]);

  const runs: RunsState = runsState.id === s.id ? runsState : { id: s.id, data: null, status: null };
  const t = s.telemetry ?? null;
  const avail = availability(s);
  const pending = board.pending[s.id] === true;
  const newest = t !== null ? t.recentCalls[t.recentCalls.length - 1] : undefined;
  const model = newest?.model ?? t?.model ?? null;
  const stateClass = signalOf(s) === "look" ? "pill look" : "pill";

  return (
    <section className="pagev" data-testid="session-view" data-session={s.id} aria-labelledby="sv-h">
      <header className="sv-head">
        <a className="sv-back" data-testid="sv-back" href="#/">
          ← Fleet
        </a>
        <h2 id="sv-h" className="sv-cs">
          {s.callsign}
        </h2>
        <span className="ad" title={s.adapter}>
          {adapterBadge(s.adapter)}
        </span>
        <span className={stateClass}>{stateLabel(s)}</span>
        <span className="sv-title">{s.title}</span>
        <span className="sv-sub">
          {s.project}
          {s.branch !== null ? ` · ${s.branch}` : ""}
          {model !== null ? ` · ${model}` : ""}
        </span>
        {t !== null ? (
          <span className="sv-sub">
            {t.sources.map((src) => (
              <span key={src} className="chip">
                {src}
              </span>
            ))}{" "}
            <span data-testid="sv-age">{`updated ${ageText(t.updatedAt, now)}`}</span>
          </span>
        ) : null}
        <span className="sv-actions">
          <RestoreButton session={s} pending={pending} actions={actions} />
          {/* With capability none the Restore button already reads Copy cwd. */}
          {s.restore.capability !== "none" && (
            <button type="button" className="btn" data-testid="sv-copy" onClick={() => onCopy(s.id)}>
              Copy cwd
            </button>
          )}
        </span>
      </header>

      {t === null ? (
        <p className="sv-nodata" data-testid="sv-nodata">
          {availabilityText(avail === "data" ? "none" : avail)}
          <span className="sv-muted">
            {" "}
            {avail === "pending"
              ? "Telemetry appears after the first model call."
              : avail === "na"
                ? "Shell sessions make no model calls."
                : "This agent has no telemetry source yet."}
          </span>
        </p>
      ) : (
        <>
          <KeyValues t={t} now={now} />
          <CallStrip t={t} />
          <section className="sv-sec" aria-label="Runs" data-testid="sv-runs">
            <h3>Runs</h3>
            <RunsTable session={s} now={now} runs={runs} />
          </section>
          <ToolsTable t={t} />
          <PermsAndInput t={t} now={now} />
          <Subagents t={t} />
          <Facts t={t} />
        </>
      )}
    </section>
  );
}
