import { describe, expect, it } from "vitest";
import { validateSession } from "@mc/contracts";
import { createCopilotFold } from "../src/telemetry.js";
import eventsRaw from "./fixtures/telemetry/events.jsonl?raw";
import otelObjectRaw from "./fixtures/telemetry/otel-object.jsonl?raw";
import otelListRaw from "./fixtures/telemetry/otel-list.jsonl?raw";

const lines = (raw: string): string[] => raw.split("\n").filter((l) => l.trim() !== "");

const line = (type: string, data: unknown, timestamp: string): string =>
  JSON.stringify({ type, data, id: `id-${type}`, parentId: null, timestamp });

const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

describe("copilot telemetry fold (D-56)", () => {
  it("TL-01 usage records: tokens, calls, model, recentCalls, subagent flag, context estimate", () => {
    const fold = createCopilotFold();
    for (const l of lines(eventsRaw)) fold.addEventLine(l);
    const snap = fold.snapshot(T0 + 120_000);
    expect(snap.tokens).toEqual({ input: 1500, output: 280, cacheRead: 300, cacheWrite: 50, reasoning: 20 });
    expect(snap.calls.total).toBe(2);
    expect(snap.model).toBe("gpt-5.1-mini");
    expect(snap.recentCalls).toHaveLength(2);
    expect(snap.recentCalls[0]).toEqual({
      at: at(10), model: "gpt-5.1", input: 1000, output: 200, failed: false, subagent: false,
    });
    expect(snap.recentCalls[1]?.subagent).toBe(true);
    expect(snap.latency.ttftP50Ms).toBe(300);
    expect(snap.latency.durationP50Ms).toBe(900);
    expect(snap.context.maxPromptTokens).toBe(8000);
  });

  it("TL-02 tokenRate counts only calls in the last 60 s", () => {
    const fold = createCopilotFold();
    for (const l of lines(eventsRaw)) fold.addEventLine(l);
    expect(fold.snapshot(T0 + 40_000).tokenRate).toBe(1780);
    expect(fold.snapshot(T0 + 80_000).tokenRate).toBe(580);
  });

  it("TL-03 checkpoint then shutdown: nanoAiu newest wins, codeChanges, currentTokens context", () => {
    const fold = createCopilotFold();
    for (const l of lines(eventsRaw)) fold.addEventLine(l);
    const snap = fold.snapshot(T0 + 120_000);
    expect(snap.credits).toEqual({ nanoAiu: 5100, aiCredits: 5100 / 1e9 });
    expect(snap.codeChanges).toEqual({ linesAdded: 12, linesRemoved: 3 });
    expect(snap.context).toEqual({ estimatePct: 50, promptTokens: 4000, maxPromptTokens: 8000 });
    expect(snap.sources).toEqual(["events"]);
    expect(snap.updatedAt).toBe(at(121));
  });

  it("TL-04 tools: runs, failed, p50, max, sort; no argument or result text", () => {
    const fold = createCopilotFold();
    const lines = [
      line("tool.execution_start", { toolCallId: "a", toolName: "view", arguments: { path: "SECRET-ARGS-7731" } }, at(0)),
      line("tool.execution_complete", { toolCallId: "a", success: true, result: { content: "SECRET-ARGS-7731" } }, at(1)),
      line("tool.execution_start", { toolCallId: "b", toolName: "view" }, at(2)),
      line("tool.execution_complete", { toolCallId: "b", success: true }, at(5)),
      line("tool.execution_start", { toolCallId: "c", toolName: "bash" }, at(6)),
      line("tool.execution_complete", { toolCallId: "c", success: false, shellExecution: "SECRET-ARGS-7731" }, at(7)),
      line("tool.execution_complete", { toolCallId: "orphan", success: true }, at(8)),
    ];
    for (const l of lines) fold.addEventLine(l);
    const snap = fold.snapshot(T0 + 10_000);
    expect(snap.tools).toEqual([
      { name: "view", runs: 2, failed: 0, p50Ms: 1000, maxMs: 3000 },
      { name: "bash", runs: 1, failed: 1, p50Ms: 1000, maxMs: 1000 },
      { name: "unknown", runs: 1, failed: 0, p50Ms: null, maxMs: null },
    ].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)));
    expect(JSON.stringify(snap)).not.toContain("SECRET-ARGS-7731");
  });

  it("TL-05 permissions and input: approved, denied, pending, waitedMs, pendingSince", () => {
    const fold = createCopilotFold();
    const lines = [
      line("permission.requested", { requestId: "p1" }, at(0)),
      line("permission.completed", { requestId: "p1", result: { kind: "approved-once" } }, at(4)),
      line("permission.requested", { requestId: "p2" }, at(10)),
      line("permission.requested", { requestId: "p3" }, at(20)),
      line("permission.completed", { requestId: "p3", result: { kind: "denied-by-user" } }, at(23)),
      line("user_input.requested", { requestId: "u1" }, at(30)),
      line("user_input.completed", { requestId: "u1" }, at(33)),
      line("user_input.requested", { requestId: "u2" }, at(40)),
    ];
    for (const l of lines) fold.addEventLine(l);
    const snap = fold.snapshot(T0 + 50_000);
    expect(snap.permissions).toEqual({
      requested: 3, approved: 1, denied: 1, pending: 1, waitedMs: 7000 , pendingSince: at(10),
    });
    expect(snap.input).toEqual({ requested: 2, waitedMs: 3000, pendingSince: at(40) });
  });

  it("TL-06 errors, model.call_failure, rate_limit, subagents, compaction, rewinds, truncations, warnings, task", () => {
    const fold = createCopilotFold();
    const lines = [
      line("session.error", { errorType: "network" }, at(0)),
      line("model.call_failure", { errorType: "timeout", model: "gpt-5.1" }, at(1)),
      line("rate_limit", {}, at(2)),
      line("subagent.started", { agentName: "explore" }, at(3)),
      line("subagent.started", { agentName: "explore" }, at(4)),
      line("subagent.completed", { agentName: "explore", model: "m1", durationMs: 50, configuredModelMatchesActual: false }, at(5)),
      line("subagent.failed", { agentName: "explore" }, at(6)),
      line("session.compaction_complete", { compactionTokensUsed: 900 }, at(7)),
      line("session.compaction_complete", {}, at(8)),
      line("session.snapshot_rewind", {}, at(9)),
      line("session.truncation", {}, at(10)),
      line("session.warning", {}, at(11)),
      line("session.task_complete", { success: true, outcome: "merged" }, at(12)),
    ];
    for (const l of lines) fold.addEventLine(l);
    const snap = fold.snapshot(T0 + 20_000);
    expect(snap.errors).toEqual({ count: 2, lastType: "timeout" });
    expect(snap.calls).toEqual({ total: 0, failed: 1, rateLimited: 1 });
    expect(snap.recentCalls).toEqual([
      { at: at(1), model: "gpt-5.1", input: 0, output: 0, failed: true, subagent: false },
    ]);
    expect(snap.subagents).toEqual([
      { name: "explore", model: null, modelMatches: null, durationMs: null, failed: false },
      { name: "explore", model: "m1", modelMatches: false, durationMs: 50, failed: true },
    ]);
    expect(snap.compaction).toEqual({ count: 2, tokens: 900 });
    expect(snap.rewinds).toBe(1);
    expect(snap.truncations).toBe(1);
    expect(snap.warnings).toBe(1);
    expect(snap.task).toEqual({ success: true, outcome: "merged" });
  });

  it("TL-07 bad JSON ignored; an unknown type counts in unknownEvents; a known ignored type does not", () => {
    const fold = createCopilotFold();
    fold.addEventLine("{not json");
    fold.addEventLine(JSON.stringify({ data: {} }));
    fold.addEventLine(JSON.stringify(null));
    expect(fold.snapshot(T0).sources).toEqual([]);
    fold.addEventLine(line("user.message", { content: "SECRET-ARGS-7731" }, at(0)));
    fold.addEventLine(line("session.idle", {}, at(1)));
    expect(fold.snapshot(T0).unknownEvents).toBe(0);
    fold.addEventLine(line("brand.new.type", {}, at(2)));
    const snap = fold.snapshot(T0);
    expect(snap.unknownEvents).toBe(1);
    expect(snap.sources).toEqual(["events"]);
  });

  it("TL-08 OTel: object and list attributes, compaction span tokens, invoke_agent nano-AIU fallback, sources", () => {
    const obj = createCopilotFold();
    for (const l of lines(otelObjectRaw)) obj.addOtelRecord(JSON.parse(l));
    const objSnap = obj.snapshot(T0);
    expect(objSnap.compaction.tokens).toBe(730);
    expect(objSnap.credits.nanoAiu).toBe(1500);
    expect(objSnap.sources).toEqual(["otel"]);

    const list = createCopilotFold();
    for (const l of lines(otelListRaw)) list.addOtelRecord(JSON.parse(l));
    const listSnap = list.snapshot(T0);
    expect(listSnap.compaction.tokens).toBe(420);
    expect(listSnap.credits.nanoAiu).toBe(2500);

    const both = createCopilotFold();
    for (const l of lines(eventsRaw)) both.addEventLine(l);
    for (const l of lines(otelObjectRaw)) both.addOtelRecord(JSON.parse(l));
    const bothSnap = both.snapshot(T0 + 120_000);
    expect(bothSnap.credits.nanoAiu).toBe(5100);
    expect(bothSnap.sources).toEqual(["events", "otel"]);
  });

  it("TL-09 a session with telemetry: snapshot passes validateSession; telemetry: null passes too", () => {
    const fold = createCopilotFold();
    for (const l of lines(eventsRaw)) fold.addEventLine(l);
    const base = {
      id: "copilot-cli:s1",
      adapter: "copilot-cli",
      nativeId: "s1",
      callsign: "MC-01",
      title: "refactor",
      cwd: "C:/work/app",
      project: "app",
      branch: "main",
      state: "idle",
      attention: { active: false, reason: null, since: null, acknowledged: false, message: null },
      startedAt: at(0),
      updatedAt: at(120),
      lastEvent: { name: "session.shutdown", at: at(120), summary: "Shutdown" },
      process: { agentPid: null, alive: null },
      host: { kind: "unknown", app: null, os: "windows", display: "win32", multiplexer: null },
      restore: { capability: "none", reason: null, lastResult: null },
      stats: { prompts: 1, tools: 1, notifications: 0, events: 12 },
      endReason: null,
    };
    const withTelemetry = validateSession({ ...base, telemetry: fold.snapshot(T0 + 120_000) });
    expect(withTelemetry.ok, JSON.stringify(withTelemetry)).toBe(true);
    const withNull = validateSession({ ...base, telemetry: null });
    expect(withNull.ok, JSON.stringify(withNull)).toBe(true);
  });
});
