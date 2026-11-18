import { useEffect, useLayoutEffect, useRef, type JSX, type MutableRefObject } from "react";
import type { Session } from "@mc/contracts";
import "../board.css";
import type { BoardActions, BoardState, DeckActions } from "../model.js";
import { onMap, Terrain, type TerrainItem } from "../terrain.js";
import { clock, signalOf, wait } from "../format.js";
import { needsYou, type Dismissed } from "../sort.js";
import { needsWord } from "./Card.js";
import { Empty } from "./Empty.js";
import { ListView } from "./ListView.js";
import { Selected } from "./Details.js";

/** Callout pills start hidden; the terrain shows each once it has a place for it. */
const hideOnMount = (el: HTMLElement | null): void => {
  if (el && el.style.transform === "") el.hidden = true;
};

/** DESIGN.md 3, the Fleet terrain hero card (and the list view that replaces its map). */
export function Board(p: {
  sessions: Session[];
  items: TerrainItem[];
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  selected: string | null;
  flyTo: { id: string | null; fly: boolean; n: number };
  listMode: boolean;
  sheetOpen: boolean;
  showEnded: boolean;
  telemetry: boolean;
  touched: boolean;
  region: string | null;
  reduced: boolean;
  theme: string;
  engineRef: MutableRefObject<Terrain | null>;
  onToggleEnded(): void;
  onTouched(t: boolean): void;
  onRegion(r: string | null): void;
  actions: BoardActions;
  deck: DeckActions;
}): JSX.Element {
  const heroRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cb = useRef({ select: p.deck.select, touched: p.onTouched, region: p.onRegion });
  cb.current = { select: p.deck.select, touched: p.onTouched, region: p.onRegion };
  const { engineRef } = p;

  useEffect(() => {
    const canvas = canvasRef.current;
    const hero = heroRef.current;
    if (!canvas || !hero) return;
    let engine: Terrain;
    try {
      engine = new Terrain(canvas, hero, {
        onSelect: (id) => cb.current.select(id),
        onTouched: (t) => cb.current.touched(t),
        onRegion: (r) => cb.current.region(r),
      });
    } catch {
      return; // no 2d canvas (jsdom): the list view and the cards still work
    }
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [engineRef]);

  useEffect(() => {
    engineRef.current?.setData(p.items);
  }, [p.items, engineRef]);
  useEffect(() => {
    engineRef.current?.setReduced(p.reduced);
  }, [p.reduced, engineRef]);
  useEffect(() => {
    engineRef.current?.readColors();
  }, [p.theme, engineRef]);
  useEffect(() => {
    engineRef.current?.setActive(!p.listMode);
  }, [p.listMode, engineRef]);
  useEffect(() => {
    engineRef.current?.setSelected(p.flyTo.id, p.flyTo.fly);
  }, [p.flyTo, engineRef]);
  // Overlay sizes change with every render (text, results): let the terrain re-measure.
  useLayoutEffect(() => {
    engineRef.current?.invalidateOverlays();
  });

  const callouts = p.sessions.filter((s) => needsYou(s, p.dismissed) || s.state === "error");
  const sel = p.sessions.find((s) => s.id === p.selected) ?? null;
  const live = p.sessions.filter(onMap);
  const regions = new Set(live.map((s) => s.project)).size;
  const dock = [...p.sessions]
    .sort((a, b) => Date.parse(b.lastEvent.at) - Date.parse(a.lastEvent.at))
    .slice(0, 4)
    .reverse();
  const narrow = typeof window !== "undefined" && window.innerWidth < 500;

  return (
    <section
      ref={heroRef}
      className="hero"
      data-testid="board"
      data-mode={p.listMode ? "list" : "map"}
      aria-label="Fleet terrain"
    >
      <canvas
        ref={canvasRef}
        data-testid="terrain"
        tabIndex={p.listMode ? -1 : 0}
        aria-label="Fleet terrain map, one region per project. Drag to orbit, wheel to zoom, shift-drag to pan. Arrow keys orbit, plus and minus zoom, 0 resets. J and K move between sessions, Enter restores. L opens the list of every session."
      />
      <div className="status">
        <h2>{p.region ?? "Fleet terrain"}</h2>
        <p>
          {regions} project{regions === 1 ? "" : "s"} · height is {p.telemetry && p.sessions.some((s) => s.telemetry) ? "token rate or activity" : "activity"}
          {narrow ? "" : " · drag to orbit"}
        </p>
      </div>
      <button
        type="button"
        className="reset"
        data-testid="reset-view"
        data-off={p.touched ? "false" : "true"}
        aria-label="Reset view"
        title="Reset view (0, or double-click)"
        onClick={() => engineRef.current?.reset()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <path d="M3 8a5 5 0 1 0 1.6-3.7" />
          <path d="M3 2.5v2.8h2.8" />
        </svg>
      </button>
      {live.length === 0 && <Empty ended={p.sessions.length} />}
      {callouts.map((s) => {
        const needs = needsYou(s, p.dismissed);
        const acked = needs && s.attention.acknowledged;
        const since = s.attention.since !== null ? Date.parse(s.attention.since) : p.now;
        return (
          <div
            key={s.id}
            ref={hideOnMount}
            className="co"
            data-testid="callout"
            data-id={s.id}
            data-attention={acked ? "acked" : "active"}
            onClick={() => p.deck.select(s.id)}
          >
            <i aria-hidden="true" />
            <b>{s.callsign}</b>
            <span className="why">{needs ? needsWord(s) : "Error"}</span>
            {needs && <span className="w num">{wait(p.now - since)}</span>}
          </div>
        );
      })}
      {sel !== null && !p.listMode && !p.sheetOpen && (
        <Selected session={sel} board={p.board} dismissed={p.dismissed} now={p.now} actions={p.actions} deck={p.deck} />
      )}
      <ol className="dock" data-testid="dock" aria-label="Latest events">
        {dock.map((s) => {
          const sig = signalOf(s);
          return (
            <li key={s.id} className={sig === "none" ? undefined : sig} data-state={s.state}>
              <i aria-hidden="true" />
              <span>
                <b className="num">{clock(Date.parse(s.lastEvent.at))}</b>
                {s.callsign} {s.lastEvent.summary}
              </span>
            </li>
          );
        })}
      </ol>
      {p.listMode && (
        <ListView
          sessions={p.sessions}
          board={p.board}
          dismissed={p.dismissed}
          now={p.now}
          selected={p.selected}
          showEnded={p.showEnded}
          onToggleEnded={p.onToggleEnded}
          actions={p.actions}
          deck={p.deck}
        />
      )}
    </section>
  );
}
