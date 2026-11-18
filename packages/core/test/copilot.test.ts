import { describe, expect, it } from "vitest";
import type { IngestEnvelope } from "@mc/contracts";
import { reduce } from "../src/attention.js";
import { summarize } from "../src/summary.js";
import { alloc, envelope, opts } from "./helpers.js";

const base = envelope("x").origin;
const cp = (event: string, payload: IngestEnvelope["payload"] = {}) =>
  envelope(event, payload, {
    adapter: "copilot-cli",
    nativeSessionId: "cp1",
    origin: { ...base, agent: { pid: 9, name: "copilot.exe" } },
  });

function run(events: IngestEnvelope[]) {
  let cur: ReturnType<typeof reduce>;
  const a = alloc();
  for (const e of events) cur = reduce(cur, { kind: "ingest", envelope: e, receivedAt: e.sentAt }, opts(), a);
  return cur!.session;
}

describe("copilot-cli reducer mapping", () => {
  it("CP-07 Copilot events drive the Claude Code rows: start, prompt, permission, tool, stop", () => {
    expect(run([cp("SessionStart", { source: "startup" })]).state).toBe("starting");
    expect(run([cp("SessionStart", { source: "startup" }), cp("UserPromptSubmit")]).state).toBe("working");
    const perm = run([cp("UserPromptSubmit"), cp("PermissionRequest", { tool_name: "bash" })]);
    expect(perm.state).toBe("needs_permission");
    expect(perm.attention).toMatchObject({ active: true, reason: "permission", message: "Permission: bash" });
    const resumed = run([cp("UserPromptSubmit"), cp("PermissionRequest", { tool_name: "bash" }), cp("PostToolUse", { tool_name: "bash" })]);
    expect(resumed.state).toBe("working");
    const done = run([cp("UserPromptSubmit"), cp("Stop")]);
    expect(done.state).toBe("idle");
    expect(done.attention).toMatchObject({ active: true, reason: "done" });
    expect(done.id).toBe("copilot-cli:cp1");
    expect(done.process.agentPid).toBe(9);
  });

  it("CP-08 agent_idle (sent as idle_prompt) is covered by done, otherwise needs_input; SessionEnd ends the session", () => {
    const afterDone = run([cp("UserPromptSubmit"), cp("Stop"), cp("Notification", { notification_type: "idle_prompt", message: "waiting" })]);
    expect(afterDone.attention.reason).toBe("done");
    const idle = run([cp("UserPromptSubmit"), cp("Notification", { notification_type: "idle_prompt", message: "waiting" })]);
    expect(idle.state).toBe("needs_input");
    expect(idle.attention).toMatchObject({ reason: "input", message: "waiting" });
    const ended = run([cp("UserPromptSubmit"), cp("SessionEnd", { reason: "user_exit" })]);
    expect(ended).toMatchObject({ state: "ended", endReason: "prompt_input_exit" });
    expect(ended.lastEvent.summary).toBe("Session end (user_exit)");
    expect(ended.process.alive).toBe(false); // D-38
    // ingest.md 6.3: every Copilot reason lands on the enum; unknown reasons fall to other.
    const mapped: Record<string, string> = {
      complete: "other",
      error: "other",
      abort: "other",
      timeout: "other",
      something_new: "other",
    };
    for (const [reason, endReason] of Object.entries(mapped)) {
      const s = run([cp("UserPromptSubmit"), cp("SessionEnd", { reason })]);
      expect(s, reason).toMatchObject({ state: "ended", endReason });
    }
  });

  it("CP-09 summaries follow the Claude Code rules for copilot-cli", () => {
    expect(summarize("copilot-cli", "PermissionRequest", { tool_name: "bash" })).toBe("Permission: bash");
    expect(summarize("copilot-cli", "Stop", {})).toBe("Turn complete");
    expect(summarize("copilot-cli", "SessionStart", { source: "startup" })).toBe("Session start (startup)");
  });
});
