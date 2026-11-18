import type { DaemonDeps, Liveness } from "./internal.js";

const HOUR_MS = 3_600_000;

export function createLiveness(
  deps: Pick<DaemonDeps, "clock" | "config" | "sessions" | "platform">,
): Liveness {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  async function checkSession(id: string): Promise<void> {
    // Re-read: an earlier apply in this pass may already have ended the session.
    const record = deps.sessions.get(id);
    if (!record) return;
    const { session } = record;
    if (session.state === "ended" || session.state === "lost") return;

    const pid = session.process.agentPid;
    if (pid !== null) {
      const startTime = record.origin?.agent?.startTime ?? null;
      const alive = await deps.platform.processAlive(pid, startTime);
      if (!alive) {
        deps.sessions.apply({ kind: "process_exited", sessionId: session.id, at: deps.clock.now() });
      }
      return;
    }

    const idleMs = deps.clock.now() - Date.parse(session.updatedAt);
    if (idleMs > deps.config.get().sessions.lostAfterHours * HOUR_MS) {
      deps.sessions.apply({ kind: "lost_timeout", sessionId: session.id, at: deps.clock.now() });
    }
  }

  async function runPass(): Promise<void> {
    const ids = deps.sessions.records().map((r) => r.session.id);
    for (const id of ids) {
      try {
        await checkSession(id);
      } catch (err) {
        // A failing check is logged, not fatal; the next pass retries it.
        console.warn("liveness check failed", { sessionId: id, error: String(err) });
      }
    }
  }

  function checkNow(): Promise<void> {
    // Overlapping calls (interval tick during a slow pass) share the running pass.
    if (!inFlight) {
      inFlight = runPass().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    start(): void {
      if (timer !== null) return;
      const intervalMs = deps.config.get().sessions.livenessIntervalSeconds * 1000;
      timer = setInterval(() => {
        void checkNow();
      }, intervalMs);
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    checkNow,
  };
}
