import type { JSX } from "react";
import type { Session } from "@mc/contracts";
import type { Link } from "../model.js";
import { counts, needsStack, needsYou, type Dismissed } from "../sort.js";
import { wait } from "../format.js";

function Check(p: { name: string; value: string; look: boolean; frac: number; bar: "go" | "look" | "" }): JSX.Element {
  return (
    <div className="chk">
      <span>{p.name}</span>
      <b className={p.look ? "num look" : "num"}>{p.value}</b>
      <div className="bar" aria-hidden="true">
        <i className={p.bar} style={{ width: `${Math.round(Math.max(0, Math.min(1, p.frac)) * 100)}%` }} />
      </div>
    </div>
  );
}

/** DESIGN.md 3, the readiness card: one percentage, one sentence, details on demand (R). */
export function Counts(p: {
  sessions: Session[];
  dismissed: Dismissed;
  link: Link;
  now: number;
  open: boolean;
  onToggle(): void;
}): JSX.Element {
  const c = counts(p.sessions, p.dismissed);
  const stack = needsStack(p.sessions, p.dismissed);
  const n = c.needs;
  const pct = c.live > 0 ? Math.round((100 * c.fine) / c.live) : 100;
  const oldest = stack.reduce<number>((min, s) => Math.min(min, s.attention.since ? Date.parse(s.attention.since) : p.now), p.now);
  const live = p.sessions.filter((s) => s.state !== "ended");
  const restorable = live.filter((s) => s.restore.capability !== "none").length;
  return (
    <section className="card ready" data-testid="counts" aria-labelledby="ready-h">
      <div className="r-h">
        <h2 id="ready-h" className="ttl">
          Fleet readiness
        </h2>
        <button
          type="button"
          className="link"
          data-testid="readiness-details"
          aria-expanded={p.open}
          title="Readiness details (R)"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle();
          }}
        >
          Details
        </button>
      </div>
      <div className="r-big">
        <b className="num" data-testid="readiness">
          {pct}
        </b>
        <sup>%</sup>
        {n > 0 ? (
          <span className="pill look">
            <i aria-hidden="true" />
            Needs you
          </span>
        ) : (
          <span className="pill go">
            <i aria-hidden="true" />
            All clear
          </span>
        )}
      </div>
      <p className="r-line" data-testid="readiness-line">
        {n > 0 ? (
          <>
            <span className="look">
              {n} session{n > 1 ? "s" : ""} need{n > 1 ? "" : "s"} you
            </span>{" "}
            · oldest <span className="num">{wait(p.now - oldest)}</span>
          </>
        ) : c.live > 0 ? (
          `${c.live} live session${c.live > 1 ? "s" : ""}, none waiting on you`
        ) : (
          "No live sessions"
        )}
      </p>
      {p.open && (
        <div className="pop" data-testid="readiness-pop" onClick={(e) => e.stopPropagation()}>
          <div className="ticks" role="img" aria-label="One tick per live session">
            {live.map((s) => (
              <span
                key={s.id}
                title={s.callsign}
                className={needsYou(s, p.dismissed) || s.state === "error" ? "look" : s.state === "lost" ? "lost" : "go"}
              />
            ))}
          </div>
          <Check name="Daemon link" value={p.link === "open" ? "Open" : "Down"} look={p.link !== "open"} frac={p.link === "open" ? 1 : 0} bar={p.link === "open" ? "go" : "look"} />
          <Check name="Needs you" value={String(n)} look={n > 0} frac={c.live ? n / c.live : 0} bar={n ? "look" : "go"} />
          <Check name="Errored" value={String(c.errors)} look={c.errors > 0} frac={c.live ? c.errors / c.live : 0} bar={c.errors ? "look" : "go"} />
          <Check name="Restore-capable" value={`${restorable}/${live.length}`} look={false} frac={live.length ? restorable / live.length : 1} bar="" />
        </div>
      )}
    </section>
  );
}
