import { useEffect, useState, useSyncExternalStore } from "react";
import type { FocusResult, Session, WsServerMessage } from "@mc/contracts";
import { api } from "./api.js";
import type { BoardActions, BoardState } from "./model.js";
import { FOCUS_MANUALLY } from "./format.js";

const RECONNECT_MS = 2000;
const PING_MS = 20000;
const RESULT_MS = 5000;
const HIGHLIGHT_MS = 3000;
const TICK_MS = 1000;

const initial: BoardState = {
  link: "connecting",
  needsPairing: false,
  state: null,
  results: {},
  pending: {},
  highlight: null,
};

type Timer = ReturnType<typeof setTimeout>;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

function report(err: unknown): void {
  console.error(err);
}

/**
 * The board store lives outside React so the WebSocket and timers keep one identity;
 * components read it through useSyncExternalStore.
 */
function createBoardStore() {
  let board: BoardState = initial;
  const listeners = new Set<() => void>();
  let running = false;
  let socket: WebSocket | null = null;
  let lastSeq: number | null = null;
  let reconnectTimer: Timer | null = null;
  let highlightTimer: Timer | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const set = (fn: (b: BoardState) => BoardState): void => {
    board = fn(board);
    for (const l of listeners) l();
  };

  const setLink = (link: BoardState["link"]): void => set((b) => ({ ...b, link }));

  const sessionById = (id: string): Session | undefined =>
    board.state?.sessions.find((s) => s.id === id);

  const showResult = (id: string, result: FocusResult): void =>
    set((b) => ({ ...b, results: { ...b.results, [id]: { result, until: Date.now() + RESULT_MS } } }));

  const restore = (id: string): void => {
    set((b) => ({ ...b, pending: { ...b.pending, [id]: true } }));
    void (async () => {
      try {
        const result = await api.restore(id);
        if (result !== null) showResult(id, result);
      } catch (err) {
        report(err);
      } finally {
        set((b) => ({ ...b, pending: without(b.pending, id) }));
      }
    })();
  };

  const actions: BoardActions = {
    restore,
    ack(id) {
      api.ack(id).catch(report);
    },
    dismiss(id) {
      api.dismiss(id).catch(report);
    },
    copyCwd(id) {
      const session = sessionById(id);
      if (!session) return;
      navigator.clipboard?.writeText(session.cwd).catch(report);
      showResult(id, {
        status: "partial",
        code: "focused_window_only",
        detail: FOCUS_MANUALLY,
        at: new Date().toISOString(),
      });
    },
    async pair(code) {
      const ok = await api.pair(code);
      if (!ok) return false;
      set((b) => ({ ...b, needsPairing: false }));
      const state = await api.state();
      if (state !== "unpaired") set((b) => ({ ...b, state }));
      connect();
      return true;
    },
  };

  const apply = (msg: WsServerMessage): void => {
    switch (msg.type) {
      case "hello":
        set((b) => ({ ...b, state: msg.state, link: "open" }));
        return;
      case "session.upsert":
        set((b) => {
          if (!b.state) return b;
          const exists = b.state.sessions.some((s) => s.id === msg.session.id);
          const sessions = exists
            ? b.state.sessions.map((s) => (s.id === msg.session.id ? msg.session : s))
            : [...b.state.sessions, msg.session];
          return { ...b, state: { ...b.state, sessions } };
        });
        return;
      case "session.remove":
        set((b) => {
          if (!b.state) return b;
          const sessions = b.state.sessions.filter((s) => s.id !== msg.id);
          return { ...b, state: { ...b.state, sessions } };
        });
        return;
      case "daemon.update":
        set((b) => (b.state ? { ...b, state: { ...b.state, daemon: msg.daemon, capabilities: msg.capabilities } } : b));
        return;
      case "notify": {
        const n = msg.notification;
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          document.visibilityState === "hidden"
        ) {
          const web = new Notification(n.title, { body: n.body, tag: n.tag });
          web.onclick = () => {
            if (n.sessionId !== null) actions.restore(n.sessionId);
            window.focus();
          };
        }
        return;
      }
      case "highlight":
        if (highlightTimer !== null) clearTimeout(highlightTimer);
        set((b) => ({ ...b, highlight: msg.sessionId }));
        highlightTimer = setTimeout(() => {
          highlightTimer = null;
          set((b) => ({ ...b, highlight: null }));
        }, HIGHLIGHT_MS);
        return;
    }
  };

  const scheduleReconnect = (): void => {
    if (!running || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  };

  /** Marks the socket closed and schedules a retry. Idempotent per socket. */
  const drop = (ws: WebSocket): void => {
    if (socket !== ws) return;
    socket = null;
    lastSeq = null;
    setLink("closed");
    scheduleReconnect();
  };

  function connect(): void {
    if (!running) return;
    if (socket !== null) socket.close();
    setLink("connecting");
    const ws = new WebSocket(`ws://${location.host}/api/ws`);
    socket = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (socket !== ws) return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        ws.close();
        drop(ws);
        return;
      }
      if (msg.type !== "hello" && (lastSeq === null || msg.seq !== lastSeq + 1)) {
        ws.close();
        drop(ws);
        return;
      }
      lastSeq = msg.seq;
      apply(msg);
    };
    ws.onclose = () => drop(ws);
  }

  const load = async (): Promise<void> => {
    try {
      const state = await api.state();
      if (state === "unpaired") {
        set((b) => ({ ...b, needsPairing: true, link: "closed" }));
        return;
      }
      set((b) => ({ ...b, state, needsPairing: false }));
      connect();
    } catch (err) {
      report(err);
      setLink("closed");
      if (running && reconnectTimer === null) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void load();
        }, RECONNECT_MS);
      }
    }
  };


  return {
    actions,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): BoardState {
      return board;
    },
    start(): () => void {
      running = true;
      void load();
      pingTimer = setInterval(() => {
        if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
      tickTimer = setInterval(() => {
        const now = Date.now();
        const expired = Object.values(board.results).some((r) => r.until <= now);
        if (expired) set((b) => ({ ...b, results: pruneResults(b.results, now) }));
      }, TICK_MS);
      return () => {
        running = false;
        if (pingTimer !== null) clearInterval(pingTimer);
        if (tickTimer !== null) clearInterval(tickTimer);
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        if (highlightTimer !== null) clearTimeout(highlightTimer);
        pingTimer = tickTimer = reconnectTimer = highlightTimer = null;
        const ws = socket;
        socket = null;
        lastSeq = null;
        ws?.close();
      };
    },
  };
}

function pruneResults(
  results: BoardState["results"],
  now: number,
): BoardState["results"] {
  const kept: BoardState["results"] = {};
  for (const [id, r] of Object.entries(results)) if (r.until > now) kept[id] = r;
  return kept;
}

export function useBoard(): { board: BoardState; actions: BoardActions } {
  const [store] = useState(createBoardStore);
  const board = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => store.start(), [store]);
  return { board, actions: store.actions };
}
