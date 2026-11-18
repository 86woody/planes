import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { Session, TracesResponse } from "@mc/contracts";
import { useBoard } from "./store.js";
import { api } from "./api.js";
import type { DeckActions } from "./model.js";
import { ActivityTracker } from "./activity.js";
import { onMap, type Terrain, type TerrainItem } from "./terrain.js";
import { needsStack, needsYou, type Dismissed } from "./sort.js";
import { useRoute } from "./route.js";
import { Bar } from "./components/Bar.js";
import { Banner } from "./components/Banner.js";
import { Counts } from "./components/Counts.js";
import { PollStrip } from "./components/PollStrip.js";
import { Board } from "./components/Board.js";
import { Sheet } from "./components/Details.js";
import { Help } from "./components/Help.js";
import { SessionView } from "./components/SessionView.js";
import { RunTrace } from "./components/RunTrace.js";
import { Telemetry } from "./components/Telemetry.js";

const NO_SESSIONS: Session[] = [];
/** Peak height from tokens per minute, log scale: 0 at 0, 1 at 50k tok/min and above. */
export const rateHeight = (rate: number): number => Math.min(1, Math.log10(1 + Math.max(0, rate)) / Math.log10(1 + 50_000));
const THEME_KEY = "mc.theme";
/** DESIGN 3a: the keys that still act on a session or run page; every other deck key is ignored there. */
const PAGE_KEYS = new Set(["Escape", "j", "k", "Enter", "?", "t"]);
const TRACE_POLL_MS = 5000;

const ATTENTION_WORD: Record<"permission" | "input" | "error" | "done", string> = {
  permission: "Needs permission",
  input: "Needs input",
  error: "Error",
  done: "Done",
};

interface Announcement {
  text: string;
  assertive: boolean;
}

interface Toast {
  id: number;
  text: string;
  sub: string;
}

const prefersReduced = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function currentTheme(): "dark" | "light" {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  const light = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
  return light ? "light" : "dark";
}

export function App(): JSX.Element {
  const { board, actions } = useBoard();
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState<Announcement>({ text: "", assertive: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ id: string | null; fly: boolean; n: number }>({ id: null, fly: false, n: 0 });
  const [listMode, setListMode] = useState(false);
  // D-61: the telemetry row shows on its own once a session reports telemetry; T overrides that
  // either way (hide it, or show it with "No data" cards).
  const [teleChoice, setTeleChoice] = useState<boolean | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [route, go] = useRoute();
  const [traces, setTraces] = useState<{ id: string; answer: TracesResponse | number | null }>({ id: "", answer: null });
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Dismissed>({});
  const [showEnded, setShowEnded] = useState(false);
  const [touched, setTouched] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [reduced, setReduced] = useState(prefersReduced);
  const [theme, setTheme] = useState<string>("auto");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const engineRef = useRef<Terrain | null>(null);
  const tracker = useRef(new ActivityTracker());
  const announced = useRef<Map<string, string>>(new Map());
  const toastId = useRef(0);

  const sessions = board.state?.sessions ?? NO_SESSIONS;
  const anyTelemetry = sessions.some((s) => s.telemetry != null);
  const telemetry = teleChoice ?? anyTelemetry;
  const teleRef = useRef(telemetry);
  teleRef.current = telemetry;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Theme (stored choice, else prefers-color-scheme) and motion preference.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") {
        document.documentElement.dataset.theme = stored;
        setTheme(stored);
      }
    } catch {
      // storage blocked: follow the system
    }
    if (typeof window.matchMedia !== "function") return;
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cs = window.matchMedia("(prefers-color-scheme: light)");
    const onRm = (): void => setReduced(rm.matches);
    const onCs = (): void => setTheme((t) => (t.startsWith("auto") ? `auto-${cs.matches ? "light" : "dark"}` : t));
    rm.addEventListener?.("change", onRm);
    cs.addEventListener?.("change", onCs);
    return () => {
      rm.removeEventListener?.("change", onRm);
      cs.removeEventListener?.("change", onCs);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? "reduce" : "full";
  }, [reduced]);

  const toast = useCallback((text: string, sub = "") => {
    const id = ++toastId.current;
    setToasts((t) => [{ id, text, sub }, ...t].slice(0, 3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  // The announcer: a new attention is read out, assertive for permission and error.
  useEffect(() => {
    const seen = announced.current;
    let next: Announcement | null = null;
    for (const s of sessions) {
      const a = s.attention;
      if (!a.active || a.acknowledged || a.reason === null) {
        seen.delete(s.id);
        continue;
      }
      if (seen.get(s.id) !== a.reason) {
        seen.set(s.id, a.reason);
        next = {
          text: `${s.callsign} ${ATTENTION_WORD[a.reason]} ${s.project}`,
          assertive: a.reason === "permission" || a.reason === "error",
        };
      }
    }
    if (next !== null) setAnnouncement(next);
  }, [sessions]);

  // Forget a selection or a dismissal whose session is gone.
  useEffect(() => {
    if (selected !== null && !sessions.some((s) => s.id === selected)) {
      setSelected(null);
      setSheetOpen(false);
    }
  }, [sessions, selected]);

  // DESIGN 3a: the session and run pages. A route whose session is unknown returns to the deck.
  const pageId = route.page === "deck" ? null : route.id;
  const pageSession = pageId === null ? null : (sessions.find((s) => s.id === pageId) ?? null);
  const onPage = pageSession !== null;
  const runSid = route.page === "run" ? route.id : null;
  const tracesData =
    runSid !== null && traces.id === runSid && typeof traces.answer === "object" && traces.answer !== null
      ? traces.answer
      : null;
  const traceLoading = runSid !== null && (traces.id !== runSid || traces.answer === null);
  const runFound =
    route.page === "run" && tracesData !== null ? (tracesData.runs.find((r) => r.traceId === route.traceId) ?? null) : null;
  const pageLive = pageSession !== null && pageSession.state !== "ended" && pageSession.state !== "lost";
  const tracePolling = pageLive && route.page === "run" && (runFound === null || !runFound.complete);
  const pollRef = useRef(false);
  pollRef.current = tracePolling;

  useEffect(() => {
    if (pageId === null || !onPage) return;
    setSelected(pageId);
    setSheetOpen(false);
    setMenuFor(null);
  }, [pageId, onPage]);

  useEffect(() => {
    if (pageId !== null && board.state !== null && !onPage) go({ page: "deck" });
  }, [pageId, onPage, board.state, go]);

  // The run page reads the session's traces: once on entering, then every 5 s while the run is open.
  useEffect(() => {
    if (runSid === null) return;
    let alive = true;
    const load = (): void => {
      void api.traces(runSid).then((r) => {
        if (!alive) return;
        setTraces((prev) => ({
          id: runSid,
          // Keep the last good answer when a refresh fails.
          answer:
            typeof r === "number" && prev.id === runSid && typeof prev.answer === "object" && prev.answer !== null
              ? prev.answer
              : r,
        }));
      });
    };
    load();
    const timer = setInterval(() => {
      if (pollRef.current) load();
    }, TRACE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runSid]);

  const stack = needsStack(sessions, dismissed);
  useEffect(() => {
    document.title = stack.length > 0 ? `(${stack.length}) Mission Control` : "Mission Control";
  }, [stack.length]);

  const select = useCallback((id: string | null, fly = true) => {
    setSelected(id);
    setMenuFor(null);
    if (id === null) setSheetOpen(false);
    setFlyTo((f) => ({ id, fly, n: f.n + 1 }));
  }, []);

  // A highlight message from the daemon selects that session (and flies to it).
  useEffect(() => {
    if (board.highlight !== null) select(board.highlight, true);
  }, [board.highlight, select]);

  const copy = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      navigator.clipboard?.writeText(s.cwd).catch(() => undefined);
      toast(`Copied the cwd of ${s.callsign}`, s.cwd);
    },
    [sessions, toast],
  );

  const deck: DeckActions = useMemo(
    () => ({
      select: (id) => select(id, false),
      details: (id) => {
        setSelected(id);
        setSheetOpen(true);
        setMenuFor(null);
      },
      dismissAlert: (id) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        setDismissed((d) => ({ ...d, [id]: s.attention.since }));
      },
      copy,
      toggleMenu: (id) => setMenuFor(id),
    }),
    [select, sessions, copy],
  );

  // Terrain items: regions are projects; height is the live token rate where a session reports one
  // (research note 10.2), else client-side activity.
  const items: TerrainItem[] = useMemo(() => {
    const t = Date.now();
    tracker.current.observe(sessions, t);
    return sessions.filter(onMap).map((s) => ({
      id: s.id,
      callsign: s.callsign,
      region: s.project,
      state: s.state,
      needs: needsYou(s, dismissed),
      acked: s.attention.acknowledged,
      activity: telemetry && s.telemetry ? rateHeight(s.telemetry.tokenRate) : tracker.current.level(s, t),
      order: Date.parse(s.startedAt),
    }));
  }, [sessions, dismissed, telemetry]);

  // Session order for J/K: by project, then start time, the same walk as the map (ended
  // sessions only in the list view, where they have rows; D-51).
  const walk = useMemo(
    () =>
      sessions.filter((s) => listMode || onMap(s)).sort(
        (a, b) => a.project.localeCompare(b.project) || Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
      ),
    [sessions, listMode],
  );

  const toggleTheme = useCallback(() => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page
    }
    setTheme(next);
  }, []);

  const toggleTelemetry = useCallback(() => {
    const on = teleRef.current;
    setTeleChoice(!on);
    toast(on ? "Telemetry hidden · T shows it" : "Telemetry shown · height is token rate where a session reports it");
  }, [toast]);

  // The keyboard map (DESIGN.md 8). State is read through a ref so the listener stays put.
  const live = useRef({ selected, sessions, stack, walk, helpOpen, popOpen, menuFor, sheetOpen, listMode, dismissed, board, route, onPage });
  live.current = { selected, sessions, stack, walk, helpOpen, popOpen, menuFor, sheetOpen, listMode, dismissed, board, route, onPage };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const st = live.current;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select")) return;
      const k = e.key;
      if (st.helpOpen) {
        if (k === "Escape" || k === "?") {
          setHelpOpen(false);
          e.preventDefault();
        }
        return;
      }
      const engine = engineRef.current;
      // A waterfall row takes Enter itself (it selects the span), so it counts as a control.
      const onControl = target?.closest("button, a, [role=menuitem], [role=row]") != null;
      const onCanvas = target?.tagName === "CANVAS";
      const sel = st.selected !== null ? st.sessions.find((s) => s.id === st.selected) : undefined;
      const key = k.length === 1 ? k.toLowerCase() : k;
      if (st.onPage) {
        // DESIGN 3a: Esc goes up one level (run -> session, session -> deck); only the page keys act.
        if (k === "Escape") {
          e.preventDefault();
          const r = st.route;
          go(r.page === "run" ? { page: "session", id: r.id } : { page: "deck" });
          return;
        }
        if (!PAGE_KEYS.has(key)) return;
      }
      if (onCanvas && (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown")) {
        e.preventDefault();
        engine?.orbitKey(k);
        return;
      }
      if (k === "+" || k === "=") return engine?.zoomKey(1 / 1.15);
      if (k === "-" || k === "_") return engine?.zoomKey(1.15);
      const cycle = (dir: number): void => {
        const ord = st.walk;
        if (ord.length === 0) return;
        const i = ord.findIndex((s) => s.id === st.selected);
        const next = ord[i < 0 ? (dir > 0 ? 0 : ord.length - 1) : (i + dir + ord.length) % ord.length];
        if (!next) return;
        if (st.onPage) go({ page: "session", id: next.id });
        else select(next.id);
      };
      switch (key) {
        case "j":
          return cycle(1);
        case "k":
          return cycle(-1);
        case "o":
          if (sel) go({ page: "session", id: sel.id });
          return;
        case "n": {
          if (st.stack.length === 0) return toast("All clear · nothing needs you");
          const i = st.stack.findIndex((s) => s.id === st.selected);
          const next = st.stack[(i + 1) % st.stack.length];
          if (next) select(next.id);
          return;
        }
        case "Enter":
          if (onControl || !sel) return;
          e.preventDefault();
          if (sel.state === "ended" || st.board.pending[sel.id]) return;
          if (sel.restore.capability === "none") actions.copyCwd(sel.id);
          else actions.restore(sel.id);
          return;
        case "a":
          if (sel && needsYou(sel, st.dismissed) && !sel.attention.acknowledged) actions.ack(sel.id);
          return;
        case "d":
          if (!sel) return;
          if (sel.state === "ended" || sel.state === "lost") actions.dismiss(sel.id);
          else if (needsYou(sel, st.dismissed)) deck.dismissAlert(sel.id);
          return;
        case "i":
          if (sel) deck.details(sel.id);
          return;
        case "r":
          return setPopOpen((o) => !o);
        case "l":
          return setListMode((m) => !m);
        case "t":
          return toggleTelemetry();
        case "?":
          return setHelpOpen(true);
        case "0":
          return engine?.reset();
        case "Escape":
          if (st.popOpen) setPopOpen(false);
          else if (st.menuFor !== null) setMenuFor(null);
          else if (st.sheetOpen) setSheetOpen(false);
          else if (st.selected !== null) select(null, false);
          else if (st.listMode) setListMode(false);
          return;
        default:
          if (k >= "1" && k <= "9") engine?.focusRegion(Number(k));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions, deck, go, select, toast, toggleTelemetry]);

  // A click outside closes the readiness popover and the card menu.
  useEffect(() => {
    if (!popOpen && menuFor === null) return;
    const close = (): void => {
      setPopOpen(false);
      setMenuFor(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [popOpen, menuFor]);

  const hostname = document.querySelector('meta[name="mc-host"]')?.getAttribute("content") ?? "";
  const state = board.state;
  const selSession = sessions.find((s) => s.id === selected) ?? null;

  return (
    <>
      <div className="app" data-testid="app">
        <Bar
          hostname={hostname}
          now={now}
          link={board.link}
          capabilities={state?.capabilities ?? null}
          daemon={state?.daemon ?? null}
          listMode={listMode}
          telemetry={telemetry}
          onList={() => setListMode((m) => !m)}
          onTelemetry={toggleTelemetry}
          onTheme={toggleTheme}
          onHelp={() => setHelpOpen(true)}
        />
        <main className={listMode && !onPage ? "main listing" : "main"}>
          {pageSession !== null && route.page === "session" && (
            <SessionView session={pageSession} board={board} now={now} actions={actions} onCopy={copy} />
          )}
          {pageSession !== null && route.page === "run" && (
            <RunTrace session={pageSession} run={runFound} loading={traceLoading} now={now} />
          )}
          {!onPage && (
            <>
              <div className="side">
                <Counts sessions={sessions} dismissed={dismissed} link={board.link} now={now} open={popOpen} onToggle={() => setPopOpen((o) => !o)} />
                <PollStrip
                  sessions={sessions}
                  board={board}
                  dismissed={dismissed}
                  now={now}
                  selected={selected}
                  menuFor={menuFor}
                  actions={actions}
                  deck={deck}
                  onMore={() => setListMode(true)}
                />
              </div>
              <Board
                sessions={sessions}
                items={items}
                board={board}
                dismissed={dismissed}
                now={now}
                selected={selected}
                flyTo={flyTo}
                listMode={listMode}
                sheetOpen={sheetOpen}
                showEnded={showEnded}
                telemetry={telemetry}
                touched={touched}
                region={region}
                reduced={reduced}
                theme={theme}
                engineRef={engineRef}
                onToggleEnded={() => setShowEnded((v) => !v)}
                onTouched={setTouched}
                onRegion={setRegion}
                actions={actions}
                deck={deck}
              />
            </>
          )}
        </main>
        {/* D-61: real telemetry, shown unless T hid it; DESIGN 3a: not on a page. */}
        {!onPage && telemetry && <Telemetry sessions={sessions} selected={selSession} account={state?.daemon.copilot ?? null} now={now} />}
      </div>
      <Banner board={board} actions={actions} />
      {sheetOpen && selSession !== null && (
        <Sheet
          session={selSession}
          board={board}
          dismissed={dismissed}
          now={now}
          actions={actions}
          deck={deck}
          onClose={() => setSheetOpen(false)}
        />
      )}
      {helpOpen && <Help onClose={() => setHelpOpen(false)} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="tst">
            {t.text}
            {t.sub !== "" && <small>{t.sub}</small>}
          </div>
        ))}
      </div>
      <div data-testid="announcer" className="sr-only" aria-live={announcement.assertive ? "assertive" : "polite"}>
        {announcement.text}
      </div>
    </>
  );
}
