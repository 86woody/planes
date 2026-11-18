import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, IngestEnvelope } from "@mc/contracts";
import { createCopilotFold } from "@mc/core";
import { resolvePaths } from "../src/paths.js";
import { createSessionService } from "../src/sessions.js";
import { createTelemetry } from "../src/telemetry.js";
import { createTraceStore } from "../src/traces.js";
import type { ConfigStore, Paths, Persistence, PersistedState, SessionChange, Logger } from "../src/internal.js";

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const NATIVE = "abc123";
const SID = `copilot-cli:${NATIVE}`;

function envelope(adapter: "claude-code" | "copilot-cli", nativeSessionId: string, event: string): IngestEnvelope {
  return {
    v: 1,
    adapter,
    event,
    nativeSessionId,
    sentAt: T0,
    seq: 0,
    payload: {},
    origin: {
      os: "windows",
      hookPid: 5151,
      agent: { pid: 4242, name: "copilot.exe" },
      ancestry: [],
      tty: null,
      env: {},
      console: { consoleHwnd: "0x1", ownerHwnd: "0x2" },
    },
  } as IngestEnvelope;
}

function memConfig(): ConfigStore {
  const cfg = {
    notifications: { on: { done: true } },
    sessions: { retainEndedHours: 24, capturePromptText: true },
    adapters: { "claude-code": { enabled: true }, "copilot-cli": { enabled: true }, shell: { enabled: false, notifyAfterSeconds: 60 } },
  } as unknown as Config;
  return { get: () => cfg, error: () => null, onChange: () => () => {}, close: () => {} };
}

const memPersistence: Persistence = {
  async load(): Promise<PersistedState> {
    return { version: 1, callsignCounter: 0, records: [] };
  },
  scheduleSave() {},
  async flush() {},
  appendEvent() {},
  async readSpool() {
    return [];
  },
  async deleteSpool() {},
};

const silent: Logger = { info() {}, warn() {}, error() {} };

function usage(input: number, output: number, ts: string): string {
  return JSON.stringify({
    type: "session.usage_record",
    data: { usage: { model: "gpt-5.1", inputTokens: input, outputTokens: output } },
    id: `id-${ts}`,
    parentId: null,
    timestamp: ts,
  });
}

/** SHA-256 over every file path and content under dir, in sorted order. */
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) {
        h.update(`dir:${full}`);
        walk(full);
      } else {
        h.update(`file:${full}`);
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("copilot telemetry service (D-56)", () => {
  let home: string;
  let copilotHome: string;
  let paths: Paths;
  let t: number;
  let sessions: ReturnType<typeof createSessionService>;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "mc-t113-mc-"));
    copilotHome = mkdtempSync(path.join(os.tmpdir(), "mc-t113-copilot-"));
    paths = resolvePaths({ MC_HOME: home }, process.platform, home);
    mkdirSync(paths.stateDir, { recursive: true });
    t = T0;
    const clock = { now: () => t };
    sessions = createSessionService({
      clock,
      config: memConfig(),
      persistence: memPersistence,
      initial: { version: 1, callsignCounter: 0, records: [] },
    });
    sessions.ingest(envelope("copilot-cli", NATIVE, "SessionStart"), T0);
    sessions.ingest(envelope("claude-code", "cc1", "SessionStart"), T0);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(copilotHome, { recursive: true, force: true });
  });

  const service = () =>
    createTelemetry(
      { clock: { now: () => t }, log: silent, sessions, paths },
      { copilotHome, tickMs: 2000 },
    );

  const eventsFile = () => path.join(copilotHome, "session-state", NATIVE, "events.jsonl");

  it("TD-01 events.jsonl usage lines set telemetry; appended lines update it; a partial last line waits for its newline", async () => {
    mkdirSync(path.dirname(eventsFile()), { recursive: true });
    const a = usage(1000, 200, "2026-11-16T10:00:01.000Z");
    const b = usage(500, 100, "2026-11-16T10:00:02.000Z");
    const c = usage(700, 50, "2026-11-16T10:00:03.000Z");
    writeFileSync(eventsFile(), `${a}\n${b}\n${c.slice(0, 40)}`);
    const tel = service();

    await tel.tickNow();
    let telemetry = sessions.get(SID)?.session.telemetry;
    expect(telemetry?.sources).toEqual(["events"]);
    expect(telemetry?.tokens.input).toBe(1500);
    expect(telemetry?.tokens.output).toBe(300);

    appendFileSync(eventsFile(), `${c.slice(40)}\n`);
    await tel.tickNow();
    telemetry = sessions.get(SID)?.session.telemetry;
    expect(telemetry?.tokens.input).toBe(2200);
    expect(telemetry?.tokens.output).toBe(350);
  });

  it("TD-02 claude-code with no transcript gets no telemetry, a missing file gives none, and COPILOT_HOME is never written", async () => {
    const tel = service();
    const before = hashTree(copilotHome);
    await tel.tickNow();
    await tel.tickNow();
    expect(sessions.get(SID)?.session.telemetry ?? null).toBeNull();
    expect(sessions.get("claude-code:cc1")?.session.telemetry ?? null).toBeNull();
    expect(hashTree(copilotHome)).toBe(before);

    mkdirSync(path.dirname(eventsFile()), { recursive: true });
    writeFileSync(eventsFile(), `${usage(10, 1, "2026-11-16T10:00:01.000Z")}\n`);
    const withFile = hashTree(copilotHome);
    await tel.tickNow();
    await tel.tickNow();
    expect(hashTree(copilotHome)).toBe(withFile);
    expect(sessions.get(SID)?.session.telemetry?.tokens.input).toBe(10);
  });

  it("TD-03 a compaction chat span for the session adds otel to sources; a span for an unknown id changes nothing", async () => {
    const otelDir = path.join(paths.stateDir, "otel");
    mkdirSync(otelDir, { recursive: true });
    const span = (id: string, compaction: boolean) =>
      JSON.stringify({
        type: "span",
        name: "chat",
        startTime: "2026-11-16T10:00:13.000Z",
        endTime: "2026-11-16T10:00:15.000Z",
        attributes: {
          "gen_ai.conversation.id": id,
          ...(compaction ? { "github.copilot.request.type": "compaction" } : {}),
          "gen_ai.usage.input_tokens": 700,
          "gen_ai.usage.output_tokens": 30,
        },
        status: { code: "OK" },
      });
    writeFileSync(path.join(otelDir, "shell-1.jsonl"), `${span(NATIVE, true)}\n`);
    const tel = service();
    await tel.tickNow();
    const telemetry = sessions.get(SID)?.session.telemetry;
    expect(telemetry?.sources).toEqual(["otel"]);
    expect(telemetry?.compaction).toEqual({ count: 0, tokens: 730 });

    appendFileSync(path.join(otelDir, "shell-1.jsonl"), `${span("no-such-session", true)}\n`);
    const snapshotBefore = JSON.stringify(sessions.get(SID)?.session.telemetry);
    await tel.tickNow();
    expect(JSON.stringify(sessions.get(SID)?.session.telemetry)).toBe(snapshotBefore);
    expect(sessions.get("copilot-cli:no-such-session")).toBeUndefined();
  });

  it("TD-04 a file replaced by a shorter one restarts the fold at the new file's sum", async () => {
    mkdirSync(path.dirname(eventsFile()), { recursive: true });
    writeFileSync(
      eventsFile(),
      [usage(1000, 1, "2026-11-16T10:00:01.000Z"), usage(1000, 1, "2026-11-16T10:00:02.000Z"), usage(1000, 1, "2026-11-16T10:00:03.000Z")].join("\n") + "\n",
    );
    const tel = service();
    await tel.tickNow();
    expect(sessions.get(SID)?.session.telemetry?.tokens.input).toBe(3000);

    writeFileSync(eventsFile(), `${usage(500, 5, "2026-11-16T10:00:04.000Z")}\n`);
    await tel.tickNow();
    expect(sessions.get(SID)?.session.telemetry?.tokens.input).toBe(500);
    expect(sessions.get(SID)?.session.telemetry?.tokens.output).toBe(5);
  });

  it("TD-05 setTelemetry emits one upsert for a new value and none for an equal value; an unknown id is a no-op", () => {
    const changes: SessionChange[] = [];
    const off = sessions.onChange((c) => changes.push(c));
    const first = createCopilotFold().snapshot(T0);
    const equal = JSON.parse(JSON.stringify(first)) as typeof first;
    const upserts = () => changes.filter((c) => c.type === "upsert").length;

    sessions.setTelemetry(SID, first);
    expect(upserts()).toBe(1);
    sessions.setTelemetry(SID, equal);
    expect(upserts()).toBe(1);
    expect(() => sessions.setTelemetry("copilot-cli:none", first)).not.toThrow();
    expect(upserts()).toBe(1);
    expect(sessions.get("copilot-cli:none")).toBeUndefined();
    off();
  });
});

describe("claude code transcripts (D-61)", () => {
  const CC = "11111111-2222-3333-4444-555555555555";
  const CSID = `claude-code:${CC}`;
  let home: string;
  let claudeHome: string;
  let paths: Paths;
  let t: number;
  let sessions: ReturnType<typeof createSessionService>;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "mc-t125-mc-"));
    claudeHome = mkdtempSync(path.join(os.tmpdir(), "mc-t125-claude-"));
    paths = resolvePaths({ MC_HOME: home }, process.platform, home);
    mkdirSync(paths.stateDir, { recursive: true });
    t = T0;
    sessions = createSessionService({
      clock: { now: () => t },
      config: memConfig(),
      persistence: memPersistence,
      initial: { version: 1, callsignCounter: 0, records: [] },
    });
    sessions.ingest(envelope("claude-code", CC, "SessionStart"), T0);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
  const line = (o: object): string => `${JSON.stringify(o)}\n`;
  const prompt = (id: string, s: number) => line({ type: "user", promptId: id, timestamp: at(s), message: { content: "hi" } });
  const call = (id: string, s: number, tool?: string) =>
    line({
      type: "assistant",
      timestamp: at(s),
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 },
        content: tool ? [{ type: "tool_use", id: tool, name: "Agent", input: {} }] : [{ type: "text", text: "ok" }],
      },
    });

  it("TD-06 a claude-code session reads its transcript and subagents into telemetry and runs; appended lines update it; the Claude folder is never written", async () => {
    const dir = path.join(claudeHome, "projects", "C--work-repo");
    mkdirSync(path.join(dir, CC, "subagents"), { recursive: true });
    const main = path.join(dir, `${CC}.jsonl`);
    writeFileSync(main, prompt("p1", 1) + call("m1", 2, "tA"));
    writeFileSync(path.join(dir, CC, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "tA" }));
    writeFileSync(path.join(dir, CC, "subagents", "agent-a1.jsonl"), call("s1", 3));
    const traces = createTraceStore({ clock: { now: () => t }, log: silent, paths, sessions });
    const tel = createTelemetry({ clock: { now: () => t }, log: silent, sessions, paths, traces }, { copilotHome: home, claudeHome, tickMs: 2000 });
    let before = hashTree(claudeHome);

    t = T0 + 5000;
    await tel.tickNow();
    expect(hashTree(claudeHome)).toBe(before);
    let telemetry = sessions.get(CSID)?.session.telemetry;
    expect(telemetry?.sources).toEqual(["transcript"]);
    expect(telemetry?.tokens).toMatchObject({ input: 20, cacheRead: 200, cacheWrite: 40, output: 10 });
    expect(telemetry?.subagents.map((s) => s.name)).toEqual(["Explore"]);
    expect(telemetry?.context).toEqual({ estimatePct: 0.1, promptTokens: 130, maxPromptTokens: 200_000 });

    appendFileSync(main, line({ type: "user", timestamp: at(4), message: { content: [{ type: "tool_result", tool_use_id: "tA", is_error: false }] } }) + call("m2", 5) + line({ type: "system", subtype: "turn_duration", durationMs: 4500, timestamp: at(6) }));
    t = T0 + 7000;
    before = hashTree(claudeHome);
    await tel.tickNow();
    telemetry = sessions.get(CSID)?.session.telemetry;
    expect(telemetry?.calls.total).toBe(3);
    expect(telemetry?.tools).toEqual([expect.objectContaining({ name: "Agent", runs: 1, failed: 0 })]);

    const runs = traces.runs(CSID);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ traceId: "p1", complete: true, durationMs: 4500, agent: "claude-code" });
    expect(runs[0]?.spans.map((s) => s.kind).sort()).toEqual(["agent", "chat", "chat", "chat", "tool"]);
    expect(hashTree(claudeHome)).toBe(before);
    await traces.flush();
  });

  it("TD-07 an unsafe or unknown session id reads nothing, and a missing Claude folder is not an error", async () => {
    sessions.ingest(envelope("claude-code", "../../etc", "SessionStart"), T0);
    const tel = createTelemetry({ clock: { now: () => t }, log: silent, sessions, paths }, { copilotHome: home, claudeHome: path.join(claudeHome, "missing"), tickMs: 2000 });
    await tel.tickNow();
    expect(sessions.get(CSID)?.session.telemetry ?? null).toBeNull();
    expect(sessions.get("claude-code:../../etc")?.session.telemetry ?? null).toBeNull();
  });
});