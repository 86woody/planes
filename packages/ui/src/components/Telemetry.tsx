import { useRef, type JSX } from "react";
import type { CopilotAccount, Session, Telemetry as Tel } from "@mc/contracts";
import { ageText, availability, availabilityText, compact } from "../telemetry-format.js";

/**
 * DESIGN.md 3, the four telemetry cards on real data (D-61; research note 10.1). They show the
 * live fleet, or the selected session only. Every value comes from Session.telemetry or
 * DaemonInfo.copilot; a card with no source says so ("No data", "n/a") and never shows a number.
 * Sparklines are the values this page has seen, one sample every 5 s, newest 48.
 */
const N = 48;
const SAMPLE_MS = 5000;
const CTX_OVER = 85;
const ERR_OVER = 5;

type Kind = "tok" | "ctx" | "cred" | "err";

interface CardValue {
  /** null: no source for this card in the current scope. */
  v: number | null;
  text: string;
  sub: string;
  over: boolean;
  pill: string;
}

interface Sample {
  at: number;
  vals: Record<Kind, number | null>;
}

const live = (s: Session): boolean => s.state !== "ended" && s.state !== "lost";
const withTel = (list: Session[]): { s: Session; t: Tel }[] =>
  list.flatMap((s) => (s.telemetry ? [{ s, t: s.telemetry }] : []));

function newest(rows: { t: Tel }[]): string | null {
  let best: string | null = null;
  for (const r of rows) if (best === null || Date.parse(r.t.updatedAt) > Date.parse(best)) best = r.t.updatedAt;
  return best;
}

function noData(scope: Session[], selected: Session | null, why?: string): CardValue {
  const a = selected === null ? null : availability(selected);
  const text =
    why ??
    (a === null
      ? scope.length === 0
        ? "No live sessions"
        : "No session reports telemetry"
      : a === "data"
        ? "No reading yet"
        : availabilityText(a));
  return { v: null, text: "—", sub: text, over: false, pill: selected !== null && availability(selected) === "na" ? "n/a" : "No data" };
}

export function cardValues(sessions: Session[], selected: Session | null, account: CopilotAccount | null, now: number): Record<Kind, CardValue> {
  const scope = selected !== null ? [selected] : sessions.filter(live);
  const rows = withTel(scope);
  const fresh = newest(rows);
  const agePill = fresh === null ? "No data" : ageText(fresh, now);
  const many = selected === null;
  const empty = noData(scope, selected);
  if (rows.length === 0) {
    const cred = credits(scope, selected, account, rows, agePill, now);
    return { tok: empty, ctx: empty, cred: cred.v === null ? empty : cred, err: empty };
  }

  // Token rate: the sum, and the busiest session.
  const rate = rows.reduce((a, r) => a + r.t.tokenRate, 0);
  const busiest = rows.reduce((b, r) => (r.t.tokenRate > b.t.tokenRate ? r : b));
  const tok: CardValue = {
    v: rate,
    text: rate >= 10_000 ? compact(rate) : Math.round(rate).toLocaleString("en-US"),
    sub: many ? `tok/min · busiest ${busiest.s.callsign}` : `tok/min · ${busiest.t.model ?? "model unknown"}`,
    over: false,
    pill: agePill,
  };

  // Context: the session nearest to full; an estimate, so ≈.
  const ctxRows = rows.filter((r) => r.t.context.estimatePct !== null);
  let ctx: CardValue;
  if (ctxRows.length === 0) ctx = noData(scope, selected, "No context reading yet");
  else {
    const top = ctxRows.reduce((b, r) => ((r.t.context.estimatePct ?? 0) > (b.t.context.estimatePct ?? 0) ? r : b));
    const pct = top.t.context.estimatePct ?? 0;
    const over = pct > CTX_OVER;
    ctx = {
      v: pct,
      text: `≈${Math.round(pct)}`,
      sub: many ? `% · nearest full ${top.s.callsign}` : `% of ${compact(top.t.context.maxPromptTokens ?? 0)} tokens`,
      over,
      pill: over ? `Over ${CTX_OVER}%` : agePill,
    };
  }

  // Error rate: failed model calls over all model calls.
  const total = rows.reduce((a, r) => a + r.t.calls.total, 0);
  const failed = rows.reduce((a, r) => a + r.t.calls.failed, 0);
  let err: CardValue;
  if (total === 0) err = noData(scope, selected, "No model calls yet");
  else {
    const pct = (100 * failed) / total;
    const worst = rows.reduce((b, r) => (r.t.errors.count > b.t.errors.count ? r : b));
    const over = pct > ERR_OVER;
    err = {
      v: pct,
      text: pct.toFixed(1),
      sub: worst.t.errors.count > 0 && worst.t.errors.lastType !== null ? `% · last ${worst.t.errors.lastType}` : `% of ${compact(total)} calls`,
      over,
      pill: over ? `Over ${ERR_OVER}%` : agePill,
    };
  }

  return { tok, ctx, cred: credits(scope, selected, account, rows, agePill, now), err };
}

/** AI Credits: Copilot only. The fleet reads the daemon's day total; a session its own. */
function credits(scope: Session[], selected: Session | null, account: CopilotAccount | null, rows: { s: Session; t: Tel }[], agePill: string, now: number): CardValue {
  const copilotRows = rows.filter((r) => r.t.credits.aiCredits !== null);
  const forecast = account?.forecastPct ?? null;
  const usedPct = account?.quota?.remainingPct != null ? 100 - account.quota.remainingPct : null;
  const month = [usedPct === null ? null : `${Math.round(usedPct)}% of month`, forecast === null ? null : `forecast ${Math.round(forecast)}%`]
    .filter((x) => x !== null)
    .join(" · ");
  const over = forecast !== null && forecast > 100;
  if (selected !== null) {
    const c = selected.telemetry?.credits.aiCredits ?? null;
    if (c === null) return noData(scope, selected, selected.adapter === "copilot-cli" ? undefined : "Copilot sessions only");
    return { v: c, text: c.toFixed(2), sub: month === "" ? "AI Credits · this session" : `AI Credits · ${month}`, over, pill: over ? "Forecast over 100%" : agePill };
  }
  const today = account?.aiCreditsToday ?? (copilotRows.length > 0 ? copilotRows.reduce((a, r) => a + (r.t.credits.aiCredits ?? 0), 0) : null);
  if (today === null && month === "") return noData(scope, null, "No Copilot sessions");
  return {
    v: today ?? 0,
    text: (today ?? 0).toFixed(2),
    sub: month === "" ? "AI Credits today" : `today · ${month}`,
    over,
    pill: over ? "Forecast over 100%" : account !== null ? ageText(account.updatedAt, now) : agePill,
  };
}

function spark(arr: number[]): { d: string; y: (v: number) => number } {
  const pts = arr.length === 1 ? [arr[0] ?? 0, arr[0] ?? 0] : arr;
  const mn = Math.min(...pts);
  const mx = Math.max(...pts);
  const r = mx - mn || 1;
  const y = (v: number): number => 28 - ((v - mn) / r) * 26;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 100).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return { d, y };
}

const SKELETON = (() => {
  let p = "";
  for (let i = 0; i <= 40; i++) p += `${i ? "L" : "M"}${i * 2.5} ${(15 + Math.sin(i * 0.55) * 5 + Math.sin(i * 1.7) * 2).toFixed(1)} `;
  return p.trim();
})();

const CARDS: { k: Kind; label: string; thr: number | null }[] = [
  { k: "tok", label: "Token rate", thr: null },
  { k: "ctx", label: "Context used", thr: CTX_OVER },
  { k: "cred", label: "AI Credits", thr: null },
  { k: "err", label: "Error rate", thr: ERR_OVER },
];

export function Telemetry(p: { sessions: Session[]; selected: Session | null; account: CopilotAccount | null; now: number }): JSX.Element {
  const vals = cardValues(p.sessions, p.selected, p.account, p.now);
  // The page's own history of what it showed, per scope; a new scope starts a new line.
  const scopeKey = p.selected?.id ?? "fleet";
  const hist = useRef<{ key: string; samples: Sample[] }>({ key: scopeKey, samples: [] });
  if (hist.current.key !== scopeKey) hist.current = { key: scopeKey, samples: [] };
  const samples = hist.current.samples;
  const last = samples[samples.length - 1];
  const snapshot: Record<Kind, number | null> = { tok: vals.tok.v, ctx: vals.ctx.v, cred: vals.cred.v, err: vals.err.v };
  if (last === undefined || p.now - last.at >= SAMPLE_MS) {
    samples.push({ at: p.now, vals: snapshot });
    if (samples.length > N) samples.shift();
  } else {
    last.vals = snapshot;
  }
  const anyData = CARDS.some((c) => vals[c.k].v !== null);

  return (
    <section className="tele" data-testid="telemetry" data-mode={anyData ? "live" : "wait"} aria-label="Telemetry">
      {CARDS.map((c) => {
        const cv = vals[c.k];
        if (cv.v === null) {
          return (
            <article key={c.k} className="card tc nodata" data-k={c.k}>
              <div className="tc-h">
                <h3>{c.label}</h3>
                <span className="pill dim">{cv.pill}</span>
              </div>
              <div className="tc-v">
                <b aria-hidden="true">—</b>
                <small>{cv.sub}</small>
              </div>
              <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
                <path className="ln" d={SKELETON} />
              </svg>
            </article>
          );
        }
        const arr = samples.map((s) => s.vals[c.k]).filter((v): v is number => v !== null);
        const { d, y } = spark(arr.length > 0 ? arr : [cv.v]);
        const mn = Math.min(...arr, cv.v);
        const mx = Math.max(...arr, cv.v);
        const ref = c.thr ?? (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : cv.v);
        const base = c.thr !== null && (ref > mx || ref < mn) ? "" : `M0 ${y(Math.max(mn, Math.min(mx, ref))).toFixed(1)} L100 ${y(Math.max(mn, Math.min(mx, ref))).toFixed(1)}`;
        return (
          <article key={c.k} className={cv.over ? "card tc over" : "card tc"} data-k={c.k}>
            <div className="tc-h">
              <h3>{c.label}</h3>
              <span className={cv.over ? "pill look" : "pill"}>
                {cv.over ? <i aria-hidden="true" /> : null}
                {cv.pill}
              </span>
            </div>
            <div className="tc-v">
              <b className="num">{cv.text}</b>
              <small>{cv.sub}</small>
            </div>
            <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <path className="base" d={base} />
              <path className="ln" d={d} />
            </svg>
          </article>
        );
      })}
    </section>
  );
}
