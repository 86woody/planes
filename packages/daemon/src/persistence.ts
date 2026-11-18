import fs from "node:fs";
import path from "node:path";
import { validateSession, type IngestEnvelope, type Session } from "@mc/contracts";
import type { Clock, Logger, Paths, Persistence, PersistedState, SessionRecord } from "./internal.js";

const DEBOUNCE_MS = 500;
const EVENTS_ROTATE_BYTES = 10 * 1024 * 1024;

function isRecordLike(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function createPersistence(paths: Paths, clock: Clock, log: Logger): Persistence {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingGet: (() => PersistedState) | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const empty = (): PersistedState => ({ version: 1, callsignCounter: 0, records: [] });

  async function quarantine(reason: string): Promise<PersistedState> {
    const target = `${paths.sessionsFile}.corrupt-${clock.now()}`;
    log.warn({ reason, file: paths.sessionsFile, renamedTo: target }, "sessions.json is corrupt; starting empty");
    try {
      await fs.promises.rename(paths.sessionsFile, target);
    } catch (err) {
      log.error({ err: String(err) }, "could not rename corrupt sessions.json");
    }
    return empty();
  }

  async function writeSnapshot(state: PersistedState): Promise<void> {
    const tmp = `${paths.sessionsFile}.tmp`;
    const body = JSON.stringify(state);
    await fs.promises.mkdir(path.dirname(paths.sessionsFile), { recursive: true });
    const handle = await fs.promises.open(tmp, "w");
    try {
      await handle.write(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, paths.sessionsFile);
  }

  function runSave(get: () => PersistedState): Promise<void> {
    const next = inFlight.then(() => writeSnapshot(get()));
    // Keep the chain alive after a failed write; the failure is logged once here.
    inFlight = next.catch((err: unknown) => {
      log.error({ err: String(err), file: paths.sessionsFile }, "sessions.json save failed");
    });
    return next;
  }

  return {
    async load(): Promise<PersistedState> {
      let text: string;
      try {
        text = await fs.promises.readFile(paths.sessionsFile, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw err;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return quarantine("invalid JSON");
      }
      if (!isRecordLike(raw) || raw.version !== 1 || !Array.isArray(raw.records)) {
        return quarantine("unsupported version or shape");
      }

      const records: SessionRecord[] = [];
      let dropped = 0;
      for (const item of raw.records) {
        if (!isRecordLike(item)) {
          dropped++;
          continue;
        }
        const checked = validateSession(item.session);
        if (!checked.ok) {
          dropped++;
          continue;
        }
        records.push({
          session: checked.value as Session,
          cursor: item.cursor as SessionRecord["cursor"],
          origin: (item.origin ?? null) as SessionRecord["origin"],
          target: (item.target ?? null) as SessionRecord["target"],
        });
      }
      if (dropped > 0) log.warn({ dropped }, "dropped invalid session records on load");

      const counter = typeof raw.callsignCounter === "number" ? raw.callsignCounter : 0;
      return { version: 1, callsignCounter: counter, records };
    },

    scheduleSave(get: () => PersistedState): void {
      pendingGet = get;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const g = pendingGet;
        pendingGet = null;
        if (g) void runSave(g);
      }, DEBOUNCE_MS);
    },

    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const g = pendingGet;
      pendingGet = null;
      if (g) await runSave(g).catch(() => undefined);
      await inFlight;
    },

    appendEvent(env: IngestEnvelope, receivedAt: number): void {
      try {
        if (fs.statSync(paths.eventsFile).size >= EVENTS_ROTATE_BYTES) {
          fs.renameSync(paths.eventsFile, `${paths.eventsFile}.1`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      fs.mkdirSync(path.dirname(paths.eventsFile), { recursive: true });
      fs.appendFileSync(paths.eventsFile, JSON.stringify({ receivedAt, envelope: env }) + "\n");
    },

    async readSpool(): Promise<{ file: string; envelope: unknown }[]> {
      let names: string[];
      try {
        names = await fs.promises.readdir(paths.spoolDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: { file: string; envelope: unknown }[] = [];
      for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
        const file = path.join(paths.spoolDir, name);
        let envelope: unknown;
        try {
          envelope = JSON.parse(await fs.promises.readFile(file, "utf8"));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          envelope = null;
        }
        out.push({ file, envelope });
      }
      return out;
    },

    async deleteSpool(file: string): Promise<void> {
      try {
        await fs.promises.unlink(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
