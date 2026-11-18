import type { IngestEnvelope, IngestOrigin, Session, SessionId } from "@mc/contracts";
import { CallsignAllocator, reduce } from "@mc/core";
import type { CoreEvent, ReducerOptions } from "@mc/core";
import type {
  Clock,
  ConfigStore,
  PersistedState,
  Persistence,
  SessionChange,
  SessionRecord,
  SessionService,
} from "./internal.js";

// Contract: docs/contracts/internal.md sections 1-2, attention.md section 1,
// ARCHITECTURE.md section 5. In-memory store; the reducer does the state logic.
const HOUR_MS = 3_600_000;
const PRUNE_EVERY_MS = 60_000;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => k in rb && same(ra[k], rb[k]));
}

function isLive(s: Session): boolean {
  return s.state !== "ended" && s.state !== "lost";
}

export function createSessionService(opts: {
  clock: Clock;
  config: ConfigStore;
  persistence: Persistence;
  initial: PersistedState;
}): SessionService {
  const { clock, config, persistence } = opts;
  const map = new Map<SessionId, SessionRecord>();
  const listeners = new Set<(c: SessionChange) => void>();
  let seqNo = 0;

  for (const r of opts.initial.records) {
    map.set(r.session.id, { session: r.session, cursor: r.cursor, origin: r.origin, target: r.target });
  }

  const alloc = new CallsignAllocator(opts.initial.callsignCounter, () => {
    const used = new Set<string>();
    for (const r of map.values()) if (isLive(r.session)) used.add(r.session.callsign);
    return used;
  });
  const callsigns = { nextCallsign: () => alloc.next() };

  const nextSeq = (): number => {
    seqNo += 1;
    return seqNo;
  };

  const emit = (c: SessionChange): void => {
    for (const cb of [...listeners]) cb(c);
  };

  const snapshot = (): PersistedState => ({
    version: 1,
    callsignCounter: alloc.counter(),
    records: sortedRecords(),
  });

  const save = (): void => persistence.scheduleSave(snapshot);

  const sortedRecords = (): SessionRecord[] =>
    [...map.values()].sort((a, b) => Date.parse(a.session.startedAt) - Date.parse(b.session.startedAt));

  const reducerOpts = (): ReducerOptions => {
    const cfg = config.get();
    return {
      doneIsAttention: cfg.notifications?.on?.done ?? true,
      capturePromptText: cfg.sessions?.capturePromptText ?? true,
      shellNotifyAfterSeconds: cfg.adapters?.shell?.notifyAfterSeconds ?? 60,
    };
  };

  // Stores a reducer result; emits an upsert only when a public field changed.
  const commit = (
    prev: SessionRecord | undefined,
    r: { session: Session; cursor: SessionRecord["cursor"]; changed: boolean },
    id: SessionId,
    origin: IngestOrigin | null,
  ): Session => {
    map.set(id, { session: r.session, cursor: r.cursor, origin, target: prev?.target ?? null });
    if (r.changed) {
      emit({ type: "upsert", prev: prev?.session, next: r.session, seq: nextSeq() });
    }
    return r.session;
  };

  const prune = (): void => {
    const hours = config.get().sessions?.retainEndedHours ?? 24;
    const cutoff = clock.now() - hours * HOUR_MS;
    let removed = false;
    for (const [id, r] of map) {
      const s = r.session;
      if (!isLive(s) && Date.parse(s.updatedAt) < cutoff) {
        map.delete(id);
        emit({ type: "remove", id, seq: nextSeq() });
        removed = true;
      }
    }
    if (removed) save();
  };

  const timer = setInterval(prune, PRUNE_EVERY_MS);
  timer.unref();

  const ingest = (env: IngestEnvelope, receivedAt: number): { sessionId: SessionId } => {
    const id = `${env.adapter}:${env.nativeSessionId}`;
    const adapterCfg = config.get().adapters as Record<string, { enabled?: boolean } | undefined> | undefined;
    if (adapterCfg?.[env.adapter]?.enabled === false) return { sessionId: id };

    persistence.appendEvent(env, receivedAt);
    const prev = map.get(id);
    const r = reduce(prev, { kind: "ingest", envelope: env, receivedAt }, reducerOpts(), callsigns);
    if (r) commit(prev, r, id, env.origin);
    prune();
    save();
    return { sessionId: id };
  };

  const apply = (ev: CoreEvent): Session | undefined => {
    if (ev.kind === "ingest") {
      const { sessionId } = ingest(ev.envelope, ev.receivedAt);
      return map.get(sessionId)?.session;
    }
    const prev = map.get(ev.sessionId);
    if (!prev) return undefined;
    const r = reduce(prev, ev, reducerOpts(), callsigns);
    const out = r ? commit(prev, r, ev.sessionId, prev.origin) : prev.session;
    prune();
    save();
    return out;
  };

  return {
    ingest,
    apply,

    setRestore(id, host, restore, target) {
      const prev = map.get(id);
      if (!prev) return;
      const next: Session = { ...prev.session, host, restore };
      const changed = !same(prev.session.host, host) || !same(prev.session.restore, restore);
      map.set(id, { ...prev, session: next, target });
      if (changed) emit({ type: "upsert", prev: prev.session, next, seq: nextSeq() });
      save();
    },

    setGit(id, project, branch) {
      const prev = map.get(id);
      if (!prev) return;
      const next: Session = { ...prev.session, project, branch };
      const changed = prev.session.project !== project || prev.session.branch !== branch;
      map.set(id, { ...prev, session: next });
      if (changed) emit({ type: "upsert", prev: prev.session, next, seq: nextSeq() });
      save();
    },

    setTelemetry(id, telemetry) {
      const prev = map.get(id);
      if (!prev) return;
      const next: Session = { ...prev.session, telemetry };
      const changed = !same(prev.session.telemetry, telemetry);
      map.set(id, { ...prev, session: next });
      if (changed) emit({ type: "upsert", prev: prev.session, next, seq: nextSeq() });
      save();
    },

    get: (id) => map.get(id),

    list: () => sortedRecords().map((r) => r.session),

    records: sortedRecords,

    remove(id) {
      const prev = map.get(id);
      if (!prev) return false;
      map.delete(id);
      emit({ type: "remove", id, seq: nextSeq() });
      save();
      return true;
    },

    seq: () => seqNo,

    nextSeq,

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
