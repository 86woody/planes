import { describe, expect, it } from "vitest";
import { claudeContextWindow, createClaudeFold, type SpanRecord } from "../src/claude-telemetry.js";

// D-61: Claude Code transcript lines. Shapes follow Claude Code 2.1.x transcripts; text fields carry
// a marker so the no-content test can prove none of it leaks.
const SECRET = "SECRET-TEXT-DO-NOT-LEAK";
const at = (s: number): string => new Date(Date.UTC(2026, 10, 17, 10, 0, s)).toISOString();

const prompt = (promptId: string, s: number): string =>
  JSON.stringify({ type: "user", uuid: `u-${promptId}`, promptId, timestamp: at(s), message: { role: "user", content: SECRET } });

interface Usage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  thinking?: number;
}

/** One content-block line of an assistant message (Claude Code writes one line per block). */
function assistant(id: string, s: number, opts: { model?: string; usage?: Usage; tool?: { id: string; name: string; input?: object }; error?: string; sidechain?: boolean } = {}): string {
  const u = opts.usage ?? {};
  const content = opts.tool
    ? [{ type: "tool_use", id: opts.tool.id, name: opts.tool.name, input: { command: SECRET, ...(opts.tool.input ?? {}) } }]
    : [{ type: "text", text: SECRET }];
  return JSON.stringify({
    type: "assistant",
    timestamp: at(s),
    isSidechain: opts.sidechain ?? false,
    ...(opts.error ? { isApiErrorMessage: true, error: opts.error } : {}),
    message: {
      id,
      model: opts.model ?? "claude-opus-5-5",
      content,
      usage: {
        input_tokens: u.input ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation_input_tokens: u.cacheWrite ?? 0,
        output_tokens: u.output ?? 0,
        output_tokens_details: { thinking_tokens: u.thinking ?? 0 },
      },
    },
  });
}

const result = (toolId: string, s: number, isError = false, decision?: object): string =>
  JSON.stringify({
    type: "user",
    timestamp: at(s),
    promptId: "p1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, is_error: isError, content: SECRET }] },
    toolUseResult: { stdout: SECRET },
    ...(decision ? { permissionDecision: decision } : {}),
  });

const turnEnd = (s: number, durationMs: number): string =>
  JSON.stringify({ type: "system", subtype: "turn_duration", durationMs, timestamp: at(s) });

const byName = (spans: SpanRecord[], prefix: string): SpanRecord[] => spans.filter((x) => x.name.startsWith(prefix));

describe("claude code fold (D-61)", () => {
  it("TL-10 usage counts once per message id across its content-block lines; tokens split; context on a 200k window", () => {
    const f = createClaudeFold();
    const usage = { input: 10, cacheRead: 40_000, cacheWrite: 2_000, output: 300, thinking: 50 };
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 2, { usage }));
    f.addLine(assistant("m1", 3, { usage, tool: { id: "t1", name: "Bash" } }));
    const snap = f.snapshot(Date.parse(at(10)));
    expect(snap.sources).toEqual(["transcript"]);
    expect(snap.model).toBe("claude-opus-5-5");
    expect(snap.tokens).toEqual({ input: 10, output: 300, cacheRead: 40_000, cacheWrite: 2_000, reasoning: 50 });
    expect(snap.calls).toEqual({ total: 1, failed: 0, rateLimited: 0 });
    expect(snap.context.promptTokens).toBe(42_010);
    expect(snap.context.maxPromptTokens).toBe(200_000);
    expect(snap.context.estimatePct).toBeCloseTo(21, 0);
    expect(snap.credits).toEqual({ nanoAiu: null, aiCredits: null });
    // Latency: first block 2 s after the prompt, last block 3 s after it.
    expect(snap.latency.ttftP50Ms).toBe(2000);
    expect(snap.latency.durationP50Ms).toBe(3000);
  });

  it("TL-11 token rate counts new tokens (input, cache write, output) of the last 60 s; the window is 1M for [1m] or a prompt over 200k", () => {
    const f = createClaudeFold();
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 1, { usage: { input: 100, cacheRead: 9_999, cacheWrite: 200, output: 50 } }));
    f.addLine(assistant("m2", 70, { usage: { input: 1, cacheRead: 250_000, output: 9 } }));
    expect(f.snapshot(Date.parse(at(71))).tokenRate).toBe(10);
    expect(f.snapshot(Date.parse(at(30))).tokenRate).toBe(350);
    const snap = f.snapshot(Date.parse(at(71)));
    expect(snap.context.maxPromptTokens).toBe(1_000_000);
    expect(claudeContextWindow("claude-sonnet-5-5[1m]", 0)).toBe(1_000_000);
    expect(claudeContextWindow("claude-haiku-5-5", 10)).toBe(200_000);
  });

  it("TL-12 tool_use and tool_result give runs, failures, durations; Skill uses the skill name; a person's or a refused permission counts", () => {
    const f = createClaudeFold();
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 1, { tool: { id: "t1", name: "Bash" } }));
    f.addLine(result("t1", 4, false, { decision: "accept", source: "config" }));
    f.addLine(assistant("m2", 5, { tool: { id: "t2", name: "Bash" } }));
    f.addLine(result("t2", 6, true, { decision: "reject", source: "config", reasonType: "classifier" }));
    f.addLine(assistant("m3", 7, { tool: { id: "t3", name: "Skill", input: { skill: "wrap-up" } } }));
    f.addLine(result("t3", 9, false, { decision: "accept", source: "user_temporary" }));
    const snap = f.snapshot(Date.parse(at(10)));
    const bash = snap.tools.find((t) => t.name === "Bash");
    expect(bash).toEqual({ name: "Bash", runs: 2, failed: 1, p50Ms: 1000, maxMs: 3000 });
    expect(snap.tools.find((t) => t.name === "wrap-up")?.runs).toBe(1);
    expect(snap.permissions).toMatchObject({ requested: 2, approved: 1, denied: 1 });
  });

  it("TL-13 a prompt is a run: model calls and tools hang under its root; turn_duration completes it; an interrupted run closes unset at the next prompt", () => {
    const f = createClaudeFold();
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 2, { tool: { id: "t1", name: "Read" } }));
    f.addLine(result("t1", 3));
    f.addLine(assistant("m2", 5));
    f.addLine(turnEnd(6, 6000));
    f.addLine(prompt("p2", 10));
    f.addLine(assistant("m3", 11));
    f.addLine(prompt("p3", 20));
    const spans = f.takeSpans();
    expect(f.takeSpans()).toEqual([]);

    const roots = byName(spans, "invoke_agent");
    expect(roots.map((r) => [r.traceId, r.status.code, r.endTime])).toEqual([
      ["p1", 1, Date.parse(at(0)) + 6000],
      ["p2", 0, Date.parse(at(11))],
    ]);
    const p1 = spans.filter((x) => x.traceId === "p1" && x.parentSpanId !== null);
    expect(new Set(p1.map((x) => x.parentSpanId))).toEqual(new Set(["run-p1"]));
    const tool = byName(spans, "execute_tool Read")[0];
    expect(tool).toMatchObject({ spanId: "tool-t1", startTime: Date.parse(at(2)), endTime: Date.parse(at(3)), status: { code: 1 } });
    const m2 = byName(spans, "chat").find((x) => x.spanId === "call-m2");
    // The second call starts when the tool result came back.
    expect(m2?.startTime).toBe(Date.parse(at(3)));
    expect(m2?.attributes["gen_ai.response.model"]).toBe("claude-opus-5-5");
  });

  it("TL-14 subagent lines add tokens, a subagent row and spans under the Agent tool; an API error message is a failed, rate-limited call", () => {
    const f = createClaudeFold();
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 1, { tool: { id: "tA", name: "Agent" } }));
    const info = { id: "a1", type: "general-purpose", toolUseId: "tA" };
    f.addLine(JSON.stringify({ type: "user", isSidechain: true, timestamp: at(2), message: { role: "user", content: SECRET } }), info);
    f.addLine(assistant("s1", 4, { model: "claude-haiku-5-5", usage: { input: 5, output: 7 }, sidechain: true, tool: { id: "tS", name: "Grep" } }), info);
    f.addLine(result("tS", 5), info);
    f.addLine(assistant("e1", 6, { error: "rate_limit_error" }));
    const snap = f.snapshot(Date.parse(at(10)));
    expect(snap.tokens.input).toBe(5);
    expect(snap.subagents).toEqual([{ name: "general-purpose", model: "claude-haiku-5-5", modelMatches: null, durationMs: 3000, failed: false }]);
    expect(snap.recentCalls.find((c) => c.subagent)?.model).toBe("claude-haiku-5-5");
    expect(snap.calls).toEqual({ total: 3, failed: 1, rateLimited: 1 });
    expect(snap.errors).toEqual({ count: 1, lastType: "rate_limit_error" });
    // The main thread's model stays the main model.
    expect(snap.model).toBe("claude-opus-5-5");
    const spans = f.takeSpans();
    const sub = spans.filter((x) => x.spanId === "call-s1" || x.spanId === "tool-tS");
    expect(sub.map((x) => [x.traceId, x.parentSpanId])).toEqual([
      ["p1", "tool-tA"],
      ["p1", "tool-tA"],
    ]);
  });

  it("TL-15 no prompt, response, tool input or tool output text reaches the snapshot or the spans; bad lines are skipped", () => {
    const f = createClaudeFold();
    f.addLine("not json");
    f.addLine(JSON.stringify({ type: "assistant" }));
    f.addLine(prompt("p1", 0));
    f.addLine(assistant("m1", 1, { tool: { id: "t1", name: "Bash" } }));
    f.addLine(result("t1", 2, true));
    f.addLine(assistant("m2", 3));
    f.addLine(turnEnd(4, 4000));
    const text = JSON.stringify([f.snapshot(Date.parse(at(5))), f.takeSpans()]);
    expect(text).not.toContain(SECRET);
  });
});
