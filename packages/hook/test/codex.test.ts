import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshHome, removeHome, runHook, spoolFiles, startFakeDaemon, type FakeDaemon } from "./support/harness.js";

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

describe("mc-hook codex", () => {
  it("CX-01 codex agent-turn-complete argument becomes an envelope with event agent-turn-complete", async () => {
    daemon = await startFakeDaemon(home);
    const arg = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "thread-42",
      "turn-id": "turn-7",
      cwd: "C:\\Fixtures\\project",
      "last-assistant-message": "Done.",
      "input-messages": ["Add a retry"],
    });
    const run = await runHook(["codex", arg], { home });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(daemon.bodies).toHaveLength(1);
    const env = JSON.parse(daemon.bodies[0] ?? "{}");
    expect(env.adapter).toBe("codex");
    expect(env.event).toBe("agent-turn-complete");
    expect(env.nativeSessionId).toBe("thread-42");
    expect(env.payload.prompt).toBe("Add a retry");
    expect(env.payload.last_assistant_message).toBe("Done.");
    expect(env.payload.cwd).toBe("C:\\Fixtures\\project");
  });

  it("CX-02 codex thread-id with illegal characters is sanitised to [A-Za-z0-9._-]", async () => {
    daemon = await startFakeDaemon(home);
    const arg = JSON.stringify({ type: "agent-turn-complete", "thread-id": "abc/def:ghi jkl.v1" });
    await runHook(["codex", arg], { home });
    expect(daemon.bodies).toHaveLength(1);
    expect(JSON.parse(daemon.bodies[0] ?? "{}").nativeSessionId).toBe("abc_def_ghi_jkl.v1");
  });

  it("CX-03 codex malformed argument exits 0 and sends nothing", async () => {
    daemon = await startFakeDaemon(home);
    const run = await runHook(["codex", "{not json"], { home });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(daemon.bodies).toHaveLength(0);
    expect(spoolFiles(home)).toHaveLength(0);
  });

  it("CX-04 codex title-generation thread creates no session, and --chain runs the original program once with the same argument", async () => {
    daemon = await startFakeDaemon(home);
    const title = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "title-1",
      "input-messages": ["Generate a concise, single-line task title for: Add a retry"],
    });
    const out = join(home, "chain-out.txt");
    const script = join(home, "chain.mjs");
    writeFileSync(script, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join("|"));`);
    const chain = Buffer.from(JSON.stringify([process.execPath, script, "extra"]), "utf8").toString("base64url");
    const run = await runHook(["codex", "--chain", chain, title], { home });
    expect(run.code).toBe(0);
    expect(daemon.bodies).toHaveLength(0);
    expect(spoolFiles(home)).toHaveLength(0);
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(out, "utf8")).toBe(`extra|${title}`);

    // A real turn still posts, and a chain that cannot start never fails the hook.
    const real = JSON.stringify({ type: "agent-turn-complete", "thread-id": "t2", "input-messages": ["Add a retry"] });
    const bad = Buffer.from(JSON.stringify(["/no/such/program-mc"]), "utf8").toString("base64url");
    const run2 = await runHook(["codex", "--chain", bad, real], { home });
    expect(run2.code).toBe(0);
    expect(daemon.bodies).toHaveLength(1);
    const junk = await runHook(["codex", "--chain", "!!!", real], { home });
    expect(junk.code).toBe(0);
  });
});
