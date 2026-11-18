import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestEnvelope, Session } from "@mc/contracts";
import { createPersistence } from "../src/persistence.js";
import type { Clock, Logger, Paths, PersistedState } from "../src/internal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "..", "contracts", "fixtures");

const session = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "sessions", "idle.json"), "utf8"),
) as Session;
const envelope = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "ingest", "cc-notification-idle.json"), "utf8"),
) as IngestEnvelope;

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let root: string;
let paths: Paths;
let clock: Clock;

function makePaths(base: string): Paths {
  const stateDir = path.join(base, "state");
  return {
    configDir: path.join(base, "config"),
    stateDir,
    configFile: path.join(base, "config", "config.json"),
    tokenFile: path.join(stateDir, "token"),
    daemonFile: path.join(stateDir, "daemon.json"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    eventsFile: path.join(stateDir, "events.jsonl"),
    spoolDir: path.join(stateDir, "spool"),
    hookErrorsFile: path.join(stateDir, "hook-errors.log"),
    logFile: path.join(stateDir, "daemon.log"),
    fakePlatformFile: path.join(stateDir, "fake-platform.jsonl"),
    installManifestFile: path.join(stateDir, "install-manifest.json"),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-persist-"));
  paths = makePaths(root);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  clock = { now: () => 1_700_000_000_000 };
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("persistence", () => {
  it("PS-01 save then load round-trips records and callsignCounter", async () => {
    vi.useFakeTimers();
    const state: PersistedState = {
      version: 1,
      callsignCounter: 7,
      records: [{ session, cursor: { lastAppliedSentAt: 42 }, origin: null, target: null }],
    };
    const writer = createPersistence(paths, clock, log);
    writer.scheduleSave(() => state);

    vi.advanceTimersByTime(499);
    expect(fs.existsSync(paths.sessionsFile)).toBe(false);
    vi.advanceTimersByTime(1);
    await writer.flush();
    expect(fs.existsSync(paths.sessionsFile)).toBe(true);
    expect(fs.existsSync(`${paths.sessionsFile}.tmp`)).toBe(false);

    const loaded = await createPersistence(paths, clock, log).load();
    expect(loaded.version).toBe(1);
    expect(loaded.callsignCounter).toBe(7);
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]?.session).toEqual(session);
    expect(loaded.records[0]?.cursor).toEqual({ lastAppliedSentAt: 42 });
  });

  it("PS-02 corrupt sessions.json is renamed and load returns empty", async () => {
    fs.writeFileSync(paths.sessionsFile, "{ not json");
    const loaded = await createPersistence(paths, clock, log).load();
    expect(loaded).toEqual({ version: 1, callsignCounter: 0, records: [] });
    expect(fs.existsSync(paths.sessionsFile)).toBe(false);
    expect(fs.existsSync(`${paths.sessionsFile}.corrupt-${clock.now()}`)).toBe(true);
    expect(log.warn).toHaveBeenCalled();

    fs.writeFileSync(paths.sessionsFile, JSON.stringify({ version: 2, callsignCounter: 1, records: [] }));
    const other = await createPersistence(paths, { now: () => 5 }, log).load();
    expect(other.records).toEqual([]);
    expect(fs.existsSync(`${paths.sessionsFile}.corrupt-5`)).toBe(true);
  });

  it("PS-03 events.jsonl rotates at 10 MiB and spool files are read in name order", async () => {
    fs.writeFileSync(paths.eventsFile, Buffer.alloc(10 * 1024 * 1024, 0x61));
    const persistence = createPersistence(paths, clock, log);
    persistence.appendEvent(envelope, 1234);

    expect(fs.statSync(`${paths.eventsFile}.1`).size).toBe(10 * 1024 * 1024);
    const lines = fs.readFileSync(paths.eventsFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ receivedAt: 1234, envelope });

    fs.mkdirSync(paths.spoolDir, { recursive: true });
    fs.writeFileSync(path.join(paths.spoolDir, "2-b.json"), JSON.stringify(envelope));
    fs.writeFileSync(path.join(paths.spoolDir, "1-a.json"), "{ broken");
    fs.writeFileSync(path.join(paths.spoolDir, "notes.txt"), "ignored");

    const spool = await persistence.readSpool();
    expect(spool.map((s) => path.basename(s.file))).toEqual(["1-a.json", "2-b.json"]);
    expect(spool[0]?.envelope).toBeNull();
    expect(spool[1]?.envelope).toEqual(envelope);

    await persistence.deleteSpool(spool[0]!.file);
    await persistence.deleteSpool(spool[0]!.file);
    expect(fs.existsSync(path.join(paths.spoolDir, "1-a.json"))).toBe(false);
  });
});
