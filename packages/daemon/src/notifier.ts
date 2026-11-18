import type { AttentionReason, OsNotification, Session, SessionId } from "@mc/contracts";
import { Coalescer, decide, decideRenotify, type NotifyContext } from "@mc/core";
import type { DaemonDeps, Notifier, SessionChange } from "./internal.js";

type Deps = Pick<
  DaemonDeps,
  "clock" | "log" | "config" | "sessions" | "platform" | "focus" | "broadcast"
>;

interface Shown {
  handle: { id: string };
  reason: AttentionReason;
  at: number;
}

const RENOTIFY_TICK_MS = 30_000;
const COALESCE_TICK_MS = 1_000;

// attention.md section 6 and sections 6.2 to 6.3: per-session last-sent memory, foreground
// suppression, coalescing, renotify ticks, withdrawal, click handling and the WebSocket mirror.
export function createNotifier(deps: Deps): Notifier {
  const { clock, log, config, sessions, platform, focus, broadcast } = deps;
  const shown = new Map<SessionId, Shown>();
  const coalescer = new Coalescer();
  let unsubscribe: (() => void) | null = null;
  let renotifyTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  async function isForeground(id: SessionId): Promise<boolean> {
    const target = sessions.get(id)?.target ?? null;
    const handle = target?.window?.handle ?? null;
    const fg = await platform.foregroundWindow();
    return handle !== null && fg !== null && fg.handle === handle;
  }

  function ctxFor(s: Session, focused: boolean): NotifyContext {
    const now = clock.now();
    const d = new Date(now);
    const last = shown.get(s.id);
    return {
      config: config.get().notifications,
      now,
      localMinutes: d.getHours() * 60 + d.getMinutes(),
      isForeground: focused,
      lastSent: last ? { reason: last.reason, at: last.at } : undefined,
    };
  }

  // Shows one notification, remembers it, mirrors it to clients, and counts it (SM-38).
  async function show(n: OsNotification): Promise<void> {
    const handle = await platform.notify(n, onClick);
    const id = n.sessionId;
    if (id !== null && handle !== null) {
      const reason = sessions.get(id)?.session.attention.reason ?? null;
      if (reason !== null) shown.set(id, { handle, reason, at: clock.now() });
    }
    broadcast({ type: "notify", notification: n });
    if (handle !== null && id !== null) {
      sessions.apply({ kind: "notified", sessionId: id, at: clock.now() });
    }
  }

  async function sendAll(ns: OsNotification[]): Promise<void> {
    for (const n of ns) await show(n);
  }

  async function handleUpsert(prev: Session | undefined, next: Session): Promise<void> {
    const id = next.id;
    const last = shown.get(id);
    if (!next.attention.active) {
      if (last) {
        await platform.withdraw(last.handle);
        shown.delete(id);
      }
      return;
    }
    const focused = await isForeground(id);
    const d = decide(prev, next, ctxFor(next, focused));
    if (d.send) await sendAll(coalescer.offer(d.notification, clock.now()));
  }

  function onChange(c: SessionChange): void {
    if (c.type !== "upsert") return;
    handleUpsert(c.prev, c.next).catch((err: unknown) => log.error({ err }, "notifier upsert failed"));
  }

  function onClick(sessionId: string | null): void {
    if (sessionId === null) return;
    const id = sessionId as SessionId;
    focus
      .restore(id, "notification")
      .then((r) => {
        if (r.status === "failed") broadcast({ type: "highlight", sessionId: id });
      })
      .catch((err: unknown) => log.error({ err }, "notification restore failed"));
  }

  async function renotifyTick(): Promise<void> {
    for (const s of sessions.list()) {
      if (!s.attention.active) continue;
      const focused = await isForeground(s.id);
      const d = decideRenotify(s, ctxFor(s, focused));
      if (d.send) await show(d.notification);
    }
  }

  return {
    start(): void {
      unsubscribe = sessions.onChange(onChange);
      renotifyTimer = setInterval(() => {
        renotifyTick().catch((err: unknown) => log.error({ err }, "renotify tick failed"));
      }, RENOTIFY_TICK_MS);
      flushTimer = setInterval(() => {
        sendAll(coalescer.flush(clock.now())).catch((err: unknown) =>
          log.error({ err }, "coalescer flush failed"),
        );
      }, COALESCE_TICK_MS);
    },

    async test(): Promise<{ sent: boolean; backend: string }> {
      const n: OsNotification = {
        sessionId: null,
        title: "MISSION CONTROL · COMMS CHECK",
        body: "Notifications are GO",
        urgency: "normal",
        tag: "test",
      };
      const handle = await platform.notify(n, onClick);
      const caps = await platform.capabilities();
      return { sent: handle !== null, backend: caps.notify ? "os" : "none" };
    },

    stop(): void {
      if (renotifyTimer !== null) clearInterval(renotifyTimer);
      if (flushTimer !== null) clearInterval(flushTimer);
      renotifyTimer = null;
      flushTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
