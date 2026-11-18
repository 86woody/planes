import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import type { Capabilities, Session, SessionId, OsNotification } from "@mc/contracts";
import type { DaemonDeps } from "./internal.js";
import { buildState, daemonInfo } from "./routes/api.js";

/**
 * Broadcast bus (internal.md 1, T026 step 6). `deps.broadcast` emits "msg" here; every
 * registered hub listens and forwards to its open browser sockets.
 */
export const wsHub = new EventEmitter();

const COALESCE_MS = 100;
const PING_MS = 20_000;
const PONG_MS = 10_000;

type Outgoing =
  | { type: "session.upsert"; session: Session }
  | { type: "session.remove"; id: SessionId }
  | { type: "notify"; notification: OsNotification }
  | { type: "highlight"; sessionId: SessionId }
  | { type: "daemon.update"; daemon: ReturnType<typeof daemonInfo>; capabilities: Capabilities };

export interface WsHub {
  /** The wire seq of the last message sent (D-27); GET /api/state reports the same value. */
  wireSeq(): number;
}

/**
 * Registers `GET /api/ws` (api.md 5) and owns the single wire seq counter (D-27). A message
 * takes `++wireSeq` only at the moment it is written to the sockets, so an upsert coalesced
 * away takes no number and every client sees previous + 1.
 */
export function registerWs(app: FastifyInstance, deps: DaemonDeps, portOf: () => number): WsHub {
  let wire = 0;
  const clients = new Set<WebSocket>();
  const pending = new Map<SessionId, { session: Session; timer: NodeJS.Timeout }>();

  const sendAll = (msg: Outgoing): void => {
    if (clients.size === 0) return;
    const text = JSON.stringify({ ...msg, seq: ++wire });
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(text);
    }
  };

  const queueUpsert = (session: Session): void => {
    const cur = pending.get(session.id);
    if (cur) {
      cur.session = session; // latest wins
      return;
    }
    const timer = setTimeout(() => {
      const p = pending.get(session.id);
      pending.delete(session.id);
      if (p) sendAll({ type: "session.upsert", session: p.session });
    }, COALESCE_MS);
    timer.unref();
    pending.set(session.id, { session, timer });
  };

  const sendRemove = (id: SessionId): void => {
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id); // the remove supersedes any pending upsert
    }
    sendAll({ type: "session.remove", id });
  };

  const offChange = deps.sessions.onChange((c) => {
    if (c.type === "upsert") queueUpsert(c.next);
    else sendRemove(c.id);
  });

  const daemonUpdate = async (): Promise<void> => {
    const capabilities = await deps.capabilities.get();
    sendAll({ type: "daemon.update", daemon: daemonInfo(deps, portOf()), capabilities });
  };

  const onMsg = (m: { type: string } & Record<string, unknown>): void => {
    if (m.type === "notify") {
      sendAll({ type: "notify", notification: m["notification"] as OsNotification });
    } else if (m.type === "highlight") {
      sendAll({ type: "highlight", sessionId: m["sessionId"] as SessionId });
    } else if (m.type === "daemon.update") {
      void daemonUpdate().catch((err: unknown) => deps.log.warn({ err: String(err) }, "daemon.update failed"));
    }
  };
  wsHub.on("msg", onMsg);

  app.get("/api/ws", { websocket: true, config: { realm: "browser" } }, async (socket) => {
    // Keep a message handler from the start: anything but a ping closes the socket (api.md 5).
    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = null;
      }
      const isPing =
        typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 1 &&
        (parsed as { type?: unknown }).type === "ping";
      if (!isPing) socket.close(1008, "only ping is accepted");
    });

    let pongTimer: NodeJS.Timeout | undefined;
    const pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.ping();
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => socket.terminate(), PONG_MS);
    }, PING_MS);
    pingTimer.unref();
    socket.on("pong", () => clearTimeout(pongTimer));
    socket.on("close", () => {
      clients.delete(socket);
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
    });

    // The snapshot and the join happen in one synchronous step after the only await, so no
    // message can fall between the hello state and the first broadcast this socket receives.
    const capabilities = await deps.capabilities.get();
    if (socket.readyState !== WebSocket.OPEN) return;
    const state = buildState(deps, portOf(), wire, capabilities);
    socket.send(JSON.stringify({ type: "hello", seq: wire, state }));
    clients.add(socket);
  });

  app.addHook("onClose", async () => {
    offChange();
    wsHub.off("msg", onMsg);
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    for (const c of clients) c.terminate();
    clients.clear();
  });

  return { wireSeq: () => wire };
}
