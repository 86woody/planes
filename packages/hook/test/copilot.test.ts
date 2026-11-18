import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnvelope } from "@mc/contracts";
import { pickAgent } from "../src/envelope.js";
import { freshHome, readRaw, removeHome, runHook, spoolFiles, startFakeDaemon, type FakeDaemon } from "./support/harness.js";

type Env = { adapter: string; event: string; nativeSessionId: string; payload: Record<string, string> };
let home: string;
let daemon: FakeDaemon | undefined;
beforeEach(() => {
  home = freshHome();
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  removeHome(home);
});

// fixture -> the event argument the installer writes into the hook entry (D-36)
const FIXTURES: [string, string][] = [
  ["copilot-sessionstart.json", "SessionStart"],
  ["copilot-userpromptsubmit.json", "UserPromptSubmit"],
  ["copilot-permissionrequest.json", "PermissionRequest"],
  ["copilot-notification.json", "Notification"],
  ["copilot-posttooluse.json", "PostToolUse"],
  ["copilot-stop.json", "Stop"],
  ["copilot-sessionend.json", "SessionEnd"],
  ["copilot-camel-pretooluse.json", "preToolUse"],
  ["copilot-camel-posttoolusefailure.json", "postToolUseFailure"],
];

async function send(file: string, event: string): Promise<{ env: Env; stdout: string }> {
  const d = daemon as FakeDaemon;
  const before = d.bodies.length;
  const run = await runHook(["copilot-cli", event], { home, stdin: readRaw(file) });
  expect(d.bodies.length, file).toBe(before + 1);
  return { env: JSON.parse(d.bodies[before] ?? "{}"), stdout: run.stdout };
}

describe("mc-hook copilot-cli", () => {
  it("CP-01 SessionStart becomes a copilot-cli envelope; source new is sent as startup", async () => {
    daemon = await startFakeDaemon(home);
    const { env } = await send("copilot-sessionstart.json", "SessionStart");
    expect(env.adapter).toBe("copilot-cli");
    expect(env.event).toBe("SessionStart");
    expect(env.nativeSessionId).toBe("cp-fixture-1");
    expect(env.payload.source).toBe("startup");
    expect(env.payload.cwd).toBe("C:\\Fixtures\\project");
  });

  it("CP-02 every copilot fixture yields a schema-valid envelope and empty stdout", async () => {
    daemon = await startFakeDaemon(home);
    for (const [file, event] of FIXTURES) {
      const { env, stdout } = await send(file, event);
      const result = validateEnvelope(env);
      expect(result.ok, `${file}: ${result.ok ? "" : result.errors.join("; ")}`).toBe(true);
      expect(stdout, file).toBe("");
    }
  });

  it("CP-03 PermissionRequest keeps tool_name and drops tool_input; camelCase payloads and names are accepted", async () => {
    daemon = await startFakeDaemon(home);
    const perm = await send("copilot-permissionrequest.json", "PermissionRequest");
    expect(perm.env.payload.tool_name).toBe("bash");
    expect(JSON.stringify(perm.env)).not.toContain("rm -rf");
    const camel = await send("copilot-camel-posttoolusefailure.json", "postToolUseFailure");
    expect(camel.env.event).toBe("PostToolUseFailure");
    expect(camel.env.nativeSessionId).toBe("cp-fixture-2");
    expect(camel.env.payload).toMatchObject({ tool_name: "edit", error: "patch failed", cwd: "C:\\Fixtures\\project" });
    expect(JSON.stringify(camel.env)).not.toContain("a.ts");
    const pre = await send("copilot-camel-pretooluse.json", "preToolUse");
    expect(pre.env.event).toBe("PreToolUse");
  });

  it("CP-04 Notification agent_idle is sent as idle_prompt; Stop and SessionEnd keep their names", async () => {
    daemon = await startFakeDaemon(home);
    const n = await send("copilot-notification.json", "Notification");
    expect(n.env.payload.notification_type).toBe("idle_prompt");
    expect(n.env.payload.message).toBe("Copilot is waiting for you");
    expect((await send("copilot-stop.json", "agentStop")).env.event).toBe("Stop");
    const end = await send("copilot-sessionend.json", "SessionEnd");
    expect(end.env.payload.reason).toBe("user_exit");
  });

  it("CP-05 malformed stdin, or no event argument, exits 0 and sends nothing", async () => {
    daemon = await startFakeDaemon(home);
    const bad = await runHook(["copilot-cli", "Stop"], { home, stdin: "{nope" });
    expect(bad.code).toBe(0);
    const noEvent = await runHook(["copilot-cli"], { home, stdin: readRaw("copilot-camel-pretooluse.json") });
    expect(noEvent.code).toBe(0);
    expect(daemon.bodies).toHaveLength(0);
    expect(spoolFiles(home)).toHaveLength(0);
  });

  it("CP-06 agent rule: the nearest entry named copilot, else null", () => {
    const p = (pid: number, name: string) => ({ pid, name, startTime: 1 }) as never;
    const chain = [p(10, "pwsh.exe"), p(11, "Copilot.exe"), p(12, "WindowsTerminal.exe")];
    expect(pickAgent("copilot-cli", chain)?.pid).toBe(11);
    expect(pickAgent("copilot-cli", [p(10, "node.exe")])).toBeNull();
  });
});
