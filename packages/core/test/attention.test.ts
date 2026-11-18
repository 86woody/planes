import { describe, expect, it, vi } from "vitest";
import type { FocusResult, Host, IngestEnvelope, Session } from "@mc/contracts";
import { validateSession } from "@mc/contracts";
import { reduce } from "../src/attention.js";
import type { CoreEvent, ReducerOptions, SessionCursor } from "../src/attention.js";
import { BASE_MS, alloc, envelope, iso, opts } from "./helpers.js";

vi.mock("../src/classify.js", () => ({
  classifyHost: (): Host => ({
    kind: "windows-terminal",
    app: "WindowsTerminal.exe",
    os: "windows",
    display: "win32",
    multiplexer: null,
  }),
}));

const CLEAR = { active: false, reason: null, since: null, acknowledged: false, message: null };
const ing = (env: IngestEnvelope): CoreEvent => ({ kind: "ingest", envelope: env, receivedAt: env.sentAt });

// Runs events through reduce() in order, validating every result with validateSession.
function scenario(o: ReducerOptions = opts()) {
  const a = alloc();
  let prev: { session: Session; cursor: SessionCursor } | undefined;
  return {
    send(ev: CoreEvent) {
      const r = reduce(prev, ev, o, a);
      if (!r) throw new Error("reduce returned undefined");
      const v = validateSession(r.session);
      expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
      prev = { session: r.session, cursor: r.cursor };
      return r;
    },
    get session(): Session {
      if (!prev) throw new Error("no session yet");
      return prev.session;
    },
  };
}

const start = (sc: ReturnType<typeof scenario>, source?: string) =>
  sc.send(ing(envelope("SessionStart", source === undefined ? { cwd: "C:\\work\\alpha" } : { source, cwd: "C:\\work\\alpha" })));

describe("attention reducer (T010)", () => {
  it("SM-01 none + SessionStart (source startup or absent) -> starting; attention clear; callsign allocated", () => {
    const sc = scenario();
    const e = envelope("SessionStart", { cwd: "C:\\work\\alpha" });
    sc.send(ing(e));
    const s = sc.session;
    expect(s.id).toBe("claude-code:s1");
    expect(s.callsign).toBe("MC-01");
    expect(s.state).toBe("starting");
    expect(s.attention).toEqual(CLEAR);
    expect(s.project).toBe("alpha");
    expect(s.title).toBe("alpha");
    expect(s.cwd).toBe("C:\\work\\alpha");
    expect(s.branch).toBeNull();
    expect(s.host.kind).toBe("windows-terminal");
    expect(s.restore).toEqual({ capability: "none", reason: null, lastResult: null });
    expect(s.process).toEqual({ agentPid: 4242, alive: true });
    expect(s.endReason).toBeNull();
    expect(s.stats).toEqual({ prompts: 0, tools: 0, notifications: 0, events: 1 });
    expect(s.lastEvent).toEqual({ name: "SessionStart", at: iso(e.sentAt), summary: "Session start (startup)" });
  });

  it("SM-02 none + SessionStart (resume, clear, compact, fork) -> idle; attention clear", () => {
    const sc = scenario();
    start(sc, "resume");
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.callsign).toBe("MC-01");
  });

  it("SM-03 ended or lost + SessionStart -> starting (startup) or idle (other); endReason null", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("SessionEnd", { reason: "logout" })));
    expect(sc.session.state).toBe("ended");
    sc.send(ing(envelope("SessionStart", { source: "resume" })));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.endReason).toBeNull();

    const sc2 = scenario();
    start(sc2);
    sc2.send(ing(envelope("SessionEnd", { reason: "logout" })));
    sc2.send(ing(envelope("SessionStart", { source: "startup" })));
    expect(sc2.session.state).toBe("starting");
    expect(sc2.session.endReason).toBeNull();
  });

  it("SM-04 live + SessionStart (compact, resume, fork) -> state and attention unchanged", () => {
    for (const source of ["compact", "resume", "fork"]) {
      const sc = scenario();
      start(sc);
      sc.send(ing(envelope("UserPromptSubmit", { prompt: "hi" })));
      sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
      const before = sc.session;
      sc.send(ing(envelope("SessionStart", { source })));
      expect(sc.session.state).toBe("needs_permission");
      expect(sc.session.attention).toEqual(before.attention);
    }
  });

  it("SM-05 live + SessionStart (clear or startup) -> starting; attention clear; stats kept", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "hi" })));
    sc.send(ing(envelope("Stop", { last_assistant_message: "ok" })));
    expect(sc.session.attention.reason).toBe("done");
    sc.send(ing(envelope("SessionStart", { source: "clear" })));
    expect(sc.session.state).toBe("starting");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.stats.prompts).toBe(1);
  });

  it("SM-06 live + UserPromptSubmit -> working; attention clear; prompts += 1; first prompt titles the card (80)", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("Stop", {})));
    expect(sc.session.attention.active).toBe(true);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "p".repeat(100) })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.stats.prompts).toBe(1);
    expect(sc.session.title).toBe("p".repeat(80));
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "second" })));
    expect(sc.session.stats.prompts).toBe(2);
    expect(sc.session.title).toBe("p".repeat(80));
  });

  it("SM-07 none + UserPromptSubmit -> created working; title from the prompt when capturePromptText", () => {
    const sc = scenario();
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "fix the build", cwd: "C:\\w\\beta" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.callsign).toBe("MC-01");
    expect(sc.session.title).toBe("fix the build");
    expect(sc.session.project).toBe("beta");
    expect(sc.session.stats).toEqual({ prompts: 1, tools: 0, notifications: 0, events: 1 });

    const off = scenario(opts({ capturePromptText: false }));
    off.send(ing(envelope("UserPromptSubmit", { prompt: "fix the build", cwd: "C:\\w\\beta" })));
    expect(off.session.title).toBe("beta");
  });

  it("SM-08 live, not waiting + PreToolUse -> working; done or error attention cleared", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("Stop", { last_assistant_message: "done" })));
    sc.send(ing(envelope("PreToolUse", { tool_name: "Bash" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.lastEvent.summary).toBe("Tool: Bash");
    expect(sc.session.stats.tools).toBe(0);

    const sc2 = scenario();
    start(sc2);
    sc2.send(ing(envelope("StopFailure", { error: "boom" })));
    sc2.send(ing(envelope("PreToolUse", { tool_name: "Bash" })));
    expect(sc2.session.state).toBe("working");
    expect(sc2.session.attention).toEqual(CLEAR);
  });

  it("SM-09 needs_permission + PreToolUse -> unchanged", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    const before = sc.session;
    sc.send(ing(envelope("PreToolUse", { tool_name: "Bash" })));
    expect(sc.session.state).toBe("needs_permission");
    expect(sc.session.attention).toEqual(before.attention);
    expect(sc.session.lastEvent.summary).toBe("Tool: Bash");
    expect(sc.session.stats.tools).toBe(0);
  });

  it("SM-10 live + PostToolUse or PostToolUseFailure -> working; attention clear; tools += 1", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    sc.send(ing(envelope("PostToolUse", { tool_name: "Bash" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.stats.tools).toBe(1);
    sc.send(ing(envelope("PostToolUseFailure", { tool_name: "Bash" })));
    expect(sc.session.stats.tools).toBe(2);
    expect(sc.session.lastEvent.summary).toBe("Tool failed: Bash");
  });

  it("SM-11 live + PermissionRequest -> needs_permission with \"Permission: Bash\"", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "run tests" })));
    const e = envelope("PermissionRequest", { tool_name: "Bash" });
    sc.send(ing(e));
    const s = sc.session;
    expect(s.state).toBe("needs_permission");
    expect(s.attention).toEqual({
      active: true,
      reason: "permission",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "Permission: Bash",
    });
    expect(s.lastEvent.summary).toBe("Permission: Bash");
    expect(s.endReason).toBeNull();
    expect(s.stats.prompts).toBe(1);
  });

  it("SM-12 live + Notification permission_prompt -> needs_permission with payload.message", () => {
    const sc = scenario();
    start(sc);
    const e = envelope("Notification", {
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });
    sc.send(ing(e));
    expect(sc.session.state).toBe("needs_permission");
    expect(sc.session.attention).toEqual({
      active: true,
      reason: "permission",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "Claude needs your permission to use Bash",
    });
    expect(sc.session.lastEvent.summary).toBe("Notice: permission_prompt");
  });

  it("SM-13 live with done attention + Notification idle_prompt -> unchanged", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("Stop", { last_assistant_message: "Done." })));
    const before = sc.session;
    sc.send(ing(envelope("Notification", { notification_type: "idle_prompt", message: "Claude is waiting" })));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual(before.attention);
    expect(sc.session.attention.message).toBe("Done.");
    expect(sc.session.lastEvent.summary).toBe("Notice: idle_prompt");
  });

  it("SM-14 live, otherwise + Notification idle_prompt -> needs_input with payload.message", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "go" })));
    const e = envelope("Notification", { notification_type: "idle_prompt", message: "Waiting for your input" });
    sc.send(ing(e));
    expect(sc.session.state).toBe("needs_input");
    expect(sc.session.attention).toEqual({
      active: true,
      reason: "input",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "Waiting for your input",
    });
  });

  it("SM-15 live + Notification elicitation_dialog, elicitation_url_dialog or agent_needs_input -> needs_input", () => {
    for (const notification_type of ["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
      const sc = scenario();
      start(sc);
      sc.send(ing(envelope("Notification", { notification_type, message: "Pick one" })));
      expect(sc.session.state).toBe("needs_input");
      expect(sc.session.attention.reason).toBe("input");
      expect(sc.session.attention.message).toBe("Pick one");
    }
  });

  it("SM-16 live + Notification of another type or no type -> unchanged; lastEvent updated", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "go" })));
    sc.send(ing(envelope("Notification", { notification_type: "auth_success" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.lastEvent.summary).toBe("Notice: auth_success");
    expect(sc.session.stats.events).toBe(3);
    sc.send(ing(envelope("Notification", { message: "no type" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.lastEvent.summary).toBe("Notice: message");
    expect(sc.session.stats.events).toBe(4);
  });

  it("SM-17 live + Stop -> idle; done with last_assistant_message or \"Turn complete\" (none when doneIsAttention is off)", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "go" })));
    const e = envelope("Stop", { last_assistant_message: "All tests pass" });
    sc.send(ing(e));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual({
      active: true,
      reason: "done",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "All tests pass",
    });
    expect(sc.session.lastEvent.summary).toBe("Turn complete");

    const bare = scenario();
    start(bare);
    bare.send(ing(envelope("Stop", {})));
    expect(bare.session.attention.message).toBe("Turn complete");

    const off = scenario(opts({ doneIsAttention: false }));
    start(off);
    off.send(ing(envelope("Stop", { last_assistant_message: "x" })));
    expect(off.session.state).toBe("idle");
    expect(off.session.attention).toEqual(CLEAR);
  });

  it("SM-18 live, not waiting + SubagentStart/Stop, PreCompact, PostCompact -> working; unchanged while waiting", () => {
    for (const name of ["SubagentStart", "SubagentStop", "PreCompact", "PostCompact"]) {
      const sc = scenario();
      start(sc);
      sc.send(ing(envelope("Stop", {})));
      sc.send(ing(envelope(name, {})));
      expect(sc.session.state).toBe("working");
      expect(sc.session.attention).toEqual(CLEAR);

      const wait = scenario();
      start(wait);
      wait.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
      const before = wait.session;
      wait.send(ing(envelope(name, {})));
      expect(wait.session.state).toBe("needs_permission");
      expect(wait.session.attention).toEqual(before.attention);
    }
  });

  it("SM-19 live + StopFailure -> error; message payload.error or \"Turn failed\"", () => {
    const sc = scenario();
    start(sc);
    const e = envelope("StopFailure", { error: "API overloaded" });
    sc.send(ing(e));
    expect(sc.session.state).toBe("error");
    expect(sc.session.attention).toEqual({
      active: true,
      reason: "error",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "API overloaded",
    });

    const bare = scenario();
    start(bare);
    bare.send(ing(envelope("StopFailure", {})));
    expect(bare.session.attention.message).toBe("Turn failed");
  });

  it("SM-20 any + SessionEnd -> ended; attention clear; endReason from payload.reason or other", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    sc.send(ing(envelope("SessionEnd", { reason: "logout" })));
    expect(sc.session.state).toBe("ended");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.endReason).toBe("logout");
    expect(sc.session.process.alive).toBe(false); // D-38

    const weird = scenario();
    start(weird);
    weird.send(ing(envelope("SessionEnd", { reason: "weird" })));
    expect(weird.session.state).toBe("ended");
    expect(weird.session.endReason).toBe("other");
  });

  it("SM-21 live + process_exited -> ended; endReason process_exit; process.alive false", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    sc.send({ kind: "process_exited", sessionId: sc.session.id, at: BASE_MS });
    expect(sc.session.state).toBe("ended");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.endReason).toBe("process_exit");
    expect(sc.session.process).toEqual({ agentPid: 4242, alive: false });
  });

  it("SM-22 live + lost_timeout -> lost; endReason lost; attention clear", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    sc.send({ kind: "lost_timeout", sessionId: sc.session.id, at: BASE_MS });
    expect(sc.session.state).toBe("lost");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.endReason).toBe("lost");
  });

  it("SM-23 ack -> acknowledged when attention is active; no-op (changed false) when inactive", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    const r = sc.send({ kind: "ack", sessionId: sc.session.id, at: BASE_MS });
    expect(r.changed).toBe(true);
    expect(sc.session.attention.acknowledged).toBe(true);
    expect(sc.session.state).toBe("needs_permission");

    const idle = scenario();
    start(idle);
    const noop = idle.send({ kind: "ack", sessionId: idle.session.id, at: BASE_MS });
    expect(noop.changed).toBe(false);
    expect(idle.session.attention).toEqual(CLEAR);
  });

  it("SM-24 stale ingest (sentAt before the cursor) -> only stats.events += 1; SessionEnd still applies", () => {
    const sc = scenario();
    const e1 = envelope("SessionStart", { cwd: "C:\\work\\alpha" });
    sc.send(ing(e1));
    const e2 = envelope("PermissionRequest", { tool_name: "Bash" });
    sc.send(ing(e2));
    const before = sc.session;
    const late = envelope("PostToolUse", { tool_name: "Bash" }, { sentAt: e1.sentAt + 1 });
    const r = sc.send(ing(late));
    expect(sc.session.state).toBe("needs_permission");
    expect(sc.session.attention).toEqual(before.attention);
    expect(sc.session.stats.tools).toBe(0);
    expect(sc.session.stats.events).toBe(3);
    expect(sc.session.updatedAt).toBe(iso(e2.sentAt));
    expect(r.changed).toBe(true);

    const end = envelope("SessionEnd", { reason: "other" }, { sentAt: e1.sentAt + 2 });
    sc.send(ing(end));
    expect(sc.session.state).toBe("ended");
  });

  it("SM-25 ended or lost by process_exit/lost + newer ingest (not SessionStart) -> revived and the live row applied", () => {
    const sc = scenario();
    start(sc);
    sc.send({ kind: "process_exited", sessionId: sc.session.id, at: BASE_MS });
    expect(sc.session.state).toBe("ended");
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "again" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.endReason).toBeNull();
    expect(sc.session.process.alive).toBe(true);
    expect(sc.session.stats.prompts).toBe(1);

    const lost = scenario();
    start(lost);
    lost.send({ kind: "lost_timeout", sessionId: lost.session.id, at: BASE_MS });
    lost.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    expect(lost.session.state).toBe("needs_permission");
    expect(lost.session.endReason).toBeNull();
    expect(lost.session.process.alive).toBe(true);
  });

  it("SM-26 ended with another endReason + ingest (not SessionStart) -> state unchanged; lastEvent updated", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("SessionEnd", { reason: "clear" })));
    const before = sc.session;
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "x" })));
    expect(sc.session.state).toBe("ended");
    expect(sc.session.endReason).toBe("clear");
    expect(sc.session.attention).toEqual(before.attention);
    expect(sc.session.lastEvent.name).toBe("UserPromptSubmit");
    expect(sc.session.lastEvent.summary).toBe("Prompt");
    expect(sc.session.stats.prompts).toBe(0);
    expect(sc.session.stats.events).toBe(3);
  });

  it("SM-27 restore_result -> restore.lastResult set; acknowledged only if ackOnRestore and not failed", () => {
    const at = iso(BASE_MS);
    const failed: FocusResult = { status: "failed", code: "not_found", detail: "no window", at };
    const ok: FocusResult = { status: "ok", code: "focused", detail: "", at };
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("PermissionRequest", { tool_name: "Bash" })));
    sc.send({ kind: "restore_result", sessionId: sc.session.id, result: failed, ackOnRestore: true });
    expect(sc.session.attention.acknowledged).toBe(false);
    expect(sc.session.restore.lastResult).toEqual(failed);
    expect(sc.session.state).toBe("needs_permission");
    sc.send({ kind: "restore_result", sessionId: sc.session.id, result: ok, ackOnRestore: true });
    expect(sc.session.attention.acknowledged).toBe(true);
    expect(sc.session.restore.lastResult).toEqual(ok);
  });

  it("SM-28 none + any other ingest -> created working, then the event's live row applied", () => {
    const sc = scenario();
    const e = envelope("PermissionRequest", { tool_name: "Bash" });
    sc.send(ing(e));
    expect(sc.session.callsign).toBe("MC-01");
    expect(sc.session.state).toBe("needs_permission");
    expect(sc.session.attention).toEqual({
      active: true,
      reason: "permission",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "Permission: Bash",
    });
    expect(sc.session.stats.events).toBe(1);
  });

  it("SM-30 codex agent-turn-complete -> created idle with done attention (SM-17)", () => {
    const sc = scenario();
    const e = envelope("agent-turn-complete", { last_assistant_message: "Tests green" }, {
      adapter: "codex",
      nativeSessionId: "c1",
    });
    sc.send(ing(e));
    const s = sc.session;
    expect(s.id).toBe("codex:c1");
    expect(s.state).toBe("idle");
    expect(s.attention).toEqual({
      active: true,
      reason: "done",
      since: iso(e.sentAt),
      acknowledged: false,
      message: "Tests green",
    });
    expect(s.lastEvent.summary).toBe("Turn complete");
  });

  it("SM-31 shell ShellStart -> starting (SM-01)", () => {
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, { adapter: "shell", nativeSessionId: "sh1" })));
    const s = sc.session;
    expect(s.id).toBe("shell:sh1");
    expect(s.state).toBe("starting");
    expect(s.attention).toEqual(CLEAR);
    expect(s.project).toBe("tool");
    expect(s.lastEvent.summary).toBe("ShellStart");
  });

  it("SM-32 shell ShellCommandStart -> working; prompts counts commands; title not set from text", () => {
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, { adapter: "shell", nativeSessionId: "sh1" })));
    sc.send(ing(envelope("ShellCommandStart", { command: "npm" }, { adapter: "shell", nativeSessionId: "sh1" })));
    expect(sc.session.state).toBe("working");
    expect(sc.session.stats.prompts).toBe(1);
    expect(sc.session.title).toBe("tool");
    expect(sc.session.lastEvent.summary).toBe("$ npm");
  });

  it("SM-33 shell ShellCommandEnd at or over notifyAfterSeconds -> idle done \"<cmd> exited <code>\"; nonzero -> error (SM-19)", () => {
    const shell = { adapter: "shell" as const, nativeSessionId: "sh1" };
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, shell)));
    sc.send(ing(envelope("ShellCommandStart", { command: "npm" }, shell)));
    sc.send(ing(envelope("ShellCommandEnd", { command: "npm", exit_code: 0, duration_ms: 90000 }, shell)));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention.reason).toBe("done");
    expect(sc.session.attention.message).toBe("npm exited 0");
    expect(sc.session.lastEvent.summary).toBe("npm exited 0");

    const bad = scenario();
    bad.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, shell)));
    bad.send(ing(envelope("ShellCommandStart", { command: "npm" }, shell)));
    bad.send(ing(envelope("ShellCommandEnd", { command: "npm", exit_code: 1, duration_ms: 90000 }, shell)));
    expect(bad.session.state).toBe("error");
    expect(bad.session.attention.reason).toBe("error");
    expect(bad.session.attention.message).toBe("Turn failed");
  });

  it("SM-34 shell ShellCommandEnd shorter than notifyAfterSeconds -> idle; attention clear", () => {
    const shell = { adapter: "shell" as const, nativeSessionId: "sh1" };
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, shell)));
    sc.send(ing(envelope("ShellCommandStart", { command: "ls" }, shell)));
    sc.send(ing(envelope("ShellCommandEnd", { command: "ls", exit_code: 2, duration_ms: 1200 }, shell)));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual(CLEAR);
  });

  it("SM-35 shell ShellPrompt -> idle; attention unchanged", () => {
    const shell = { adapter: "shell" as const, nativeSessionId: "sh1" };
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, shell)));
    sc.send(ing(envelope("ShellCommandStart", { command: "npm" }, shell)));
    sc.send(ing(envelope("ShellCommandEnd", { command: "npm", exit_code: 0, duration_ms: 90000 }, shell)));
    const before = sc.session;
    sc.send(ing(envelope("ShellPrompt", {}, shell)));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toEqual(before.attention);
    expect(sc.session.lastEvent.summary).toBe("ShellPrompt");
  });

  it("SM-36 shell ShellExit -> ended; endReason other (SM-20)", () => {
    const shell = { adapter: "shell" as const, nativeSessionId: "sh1" };
    const sc = scenario();
    sc.send(ing(envelope("ShellStart", { cwd: "C:\\src\\tool" }, shell)));
    sc.send(ing(envelope("ShellExit", { exit_code: 0 }, shell)));
    expect(sc.session.state).toBe("ended");
    expect(sc.session.endReason).toBe("other");
    expect(sc.session.attention).toEqual(CLEAR);
    expect(sc.session.lastEvent.summary).toBe("ShellExit");
  });

  it("SM-37 generic Start/Working/NeedsInput/NeedsPermission/Done/Error/End -> SM-01/10/15/12/17/19/20", () => {
    const g = { adapter: "generic" as const, nativeSessionId: "g1" };
    const sc = scenario();
    sc.send(ing(envelope("Start", { cwd: "C:\\src\\gen" }, g)));
    expect(sc.session.state).toBe("starting");
    sc.send(ing(envelope("Working", {}, g)));
    expect(sc.session.state).toBe("working");
    expect(sc.session.stats.tools).toBe(1);
    sc.send(ing(envelope("NeedsInput", { message: "Which branch?" }, g)));
    expect(sc.session.state).toBe("needs_input");
    expect(sc.session.attention).toMatchObject({ reason: "input", message: "Which branch?" });
    sc.send(ing(envelope("NeedsPermission", { message: "Run rm?" }, g)));
    expect(sc.session.state).toBe("needs_permission");
    expect(sc.session.attention).toMatchObject({ reason: "permission", message: "Run rm?" });
    sc.send(ing(envelope("Done", { last_assistant_message: "ok" }, g)));
    expect(sc.session.state).toBe("idle");
    expect(sc.session.attention).toMatchObject({ reason: "done", message: "ok" });
    sc.send(ing(envelope("Error", { error: "boom" }, g)));
    expect(sc.session.state).toBe("error");
    expect(sc.session.attention).toMatchObject({ reason: "error", message: "boom" });
    sc.send(ing(envelope("End", {}, g)));
    expect(sc.session.state).toBe("ended");
    expect(sc.session.endReason).toBe("other");
  });

  it("SM-38 notified -> stats.notifications += 1; updatedAt unchanged; changed true", () => {
    const sc = scenario();
    start(sc);
    sc.send(ing(envelope("UserPromptSubmit", { prompt: "go" })));
    const before = sc.session;
    const r = sc.send({ kind: "notified", sessionId: before.id, at: BASE_MS });
    expect(sc.session.stats.notifications).toBe(1);
    expect(sc.session.updatedAt).toBe(before.updatedAt);
    expect(sc.session.state).toBe(before.state);
    expect(r.changed).toBe(true);
  });
});
