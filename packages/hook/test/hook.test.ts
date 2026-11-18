import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEnvelope } from "@mc/contracts";
import { resolvePaths } from "../src/paths.js";
import {
  errorLines,
  freshHome,
  rawFixtures,
  readRaw,
  removeHome,
  runHook,
  spoolFiles,
  startFakeDaemon,
  TOKEN,
  type FakeDaemon,
} from "./support/harness.js";

const sessionStart = () => readRaw("cc-session-start.json");

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

describe("mc-hook claude-code", () => {
  it("HK-01 SessionStart is POSTed with nativeSessionId, event and allowlisted payload", async () => {
    daemon = await startFakeDaemon(home);
    const run = await runHook(["claude-code"], { home, stdin: sessionStart() });
    expect(run.code).toBe(0);
    expect(daemon.bodies).toHaveLength(1);
    const env = JSON.parse(daemon.bodies[0] ?? "{}");
    expect(env.adapter).toBe("claude-code");
    expect(env.event).toBe("SessionStart");
    expect(env.nativeSessionId).toBe("fixture-1");
    expect(env.payload.source).toBe("startup");
    expect(env.payload.model).toBe("fixture-model");
    expect(env.payload.permission_mode).toBe("default");
    expect(daemon.authorizations[0]).toBe(`Bearer ${TOKEN}`);
    expect(spoolFiles(home)).toHaveLength(0);
    // ingest.md 3 (D-26): on Windows the console fields come from koffi GetConsoleWindow /
    // GetAncestor. Shape is always checked; the handle is only read, never focused.
    const console = env.origin.console as { consoleHwnd: string | null; ownerHwnd: string | null };
    if (process.platform === "win32") {
      const hex = /^0x[0-9A-F]{16}$/;
      expect(console.consoleHwnd === null || hex.test(console.consoleHwnd)).toBe(true);
      expect(console.ownerHwnd === null || hex.test(console.ownerHwnd)).toBe(true);
      if (console.consoleHwnd === null) expect(console.ownerHwnd).toBeNull();
    } else {
      expect(console).toEqual({ consoleHwnd: null, ownerHwnd: null });
    }
  });

  it("HK-02 the envelope validates against ingest.schema.json", async () => {
    daemon = await startFakeDaemon(home);
    for (const name of rawFixtures()) {
      await runHook(["claude-code"], { home, stdin: readRaw(name) });
    }
    expect(daemon.bodies.length).toBe(rawFixtures().length);
    for (const body of daemon.bodies) {
      const result = validateEnvelope(JSON.parse(body));
      expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    }
  });

  it("HK-03 daemon down: exits 0 within 1500 ms and writes one spool file", async () => {
    const run = await runHook(["claude-code"], { home, stdin: sessionStart() });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(1500);
    expect(spoolFiles(home)).toHaveLength(1);
  });

  it("HK-04 daemon hangs (never responds): exits 0 within 1500 ms and spools", async () => {
    daemon = await startFakeDaemon(home, "hang");
    const run = await runHook(["claude-code"], { home, stdin: sessionStart() });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(1500);
    expect(spoolFiles(home)).toHaveLength(1);
  });

  it("HK-05 PermissionRequest tool_input and permission_suggestions are not sent", async () => {
    daemon = await startFakeDaemon(home);
    await runHook(["claude-code"], { home, stdin: readRaw("cc-permission-request.json") });
    expect(daemon.bodies).toHaveLength(1);
    const body = daemon.bodies[0] ?? "";
    expect(body).not.toContain("tool_input");
    expect(body).not.toContain("permission_suggestions");
    expect(body).not.toContain("npm test");
    expect(JSON.parse(body).payload.tool_name).toBe("Bash");
  });

  it("HK-06 env outside the allowlist is not sent; SSH_CONNECTION becomes \"present\"; prompt is truncated to 200 code points", async () => {
    daemon = await startFakeDaemon(home);
    const prompt = "\u{1F642}".repeat(250);
    const stdin = JSON.stringify({
      session_id: "fixture-1",
      cwd: "C:\\Fixtures\\project",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });
    await runHook(["claude-code"], {
      home,
      stdin,
      env: {
        SSH_CONNECTION: "10.0.0.5 5000 10.0.0.9 22",
        HK_SECRET_VALUE: "hunter2-secret",
        TERM_PROGRAM: "x".repeat(300),
      },
    });
    expect(daemon.bodies).toHaveLength(1);
    const body = daemon.bodies[0] ?? "";
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain("hunter2-secret");
    expect(body).not.toContain("HK_SECRET_VALUE");
    const env = JSON.parse(body);
    expect(env.origin.env.SSH_CONNECTION).toBe("present");
    expect(env.origin.env.TERM_PROGRAM).toHaveLength(256);
    expect(Array.from(env.payload.prompt as string)).toHaveLength(200);
  });

  it("HK-07 stdout is empty for every fixture", async () => {
    daemon = await startFakeDaemon(home);
    for (const name of rawFixtures()) {
      const run = await runHook(["claude-code"], { home, stdin: readRaw(name) });
      expect(run.stdout, name).toBe("");
    }
  });

  it("HK-08 malformed stdin: exit 0, nothing sent, one hook-errors.log line", async () => {
    daemon = await startFakeDaemon(home);
    const run = await runHook(["claude-code"], { home, stdin: "{not json" });
    expect(run.code).toBe(0);
    expect(daemon.bodies).toHaveLength(0);
    expect(spoolFiles(home)).toHaveLength(0);
    expect(errorLines(home)).toHaveLength(1);
  });

  it("HK-09 capturePromptText false: prompt and last_assistant_message are omitted", async () => {
    daemon = await startFakeDaemon(home);
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify({ sessions: { capturePromptText: false } }));
    await runHook(["claude-code"], { home, stdin: readRaw("cc-user-prompt.json") });
    await runHook(["claude-code"], {
      home,
      stdin: JSON.stringify({
        session_id: "fixture-1",
        cwd: "C:\\Fixtures\\project",
        hook_event_name: "Stop",
        last_assistant_message: "All done.",
      }),
    });
    expect(daemon.bodies).toHaveLength(2);
    for (const body of daemon.bodies) {
      const payload = JSON.parse(body).payload;
      expect(payload).not.toHaveProperty("prompt");
      expect(payload).not.toHaveProperty("last_assistant_message");
    }
  });

  it("HK-10 spool keeps at most 1000 files, deleting the oldest", async () => {
    const spoolDir = join(home, "state", "spool");
    mkdirSync(spoolDir, { recursive: true });
    for (let i = 1; i <= 1000; i++) {
      writeFileSync(join(spoolDir, `${String(i).padStart(13, "0")}-1-0.json`), "{}");
    }
    const run = await runHook(["claude-code"], { home, stdin: sessionStart() });
    expect(run.code).toBe(0);
    const files = readdirSync(spoolDir).filter((f) => f.endsWith(".json")).sort();
    expect(files).toHaveLength(1000);
    expect(files).not.toContain(`${String(1).padStart(13, "0")}-1-0.json`);
    expect(files).toContain(`${String(2).padStart(13, "0")}-1-0.json`);
  });

  it("HK-11 paths.ts resolves every case in packages/daemon/test/fixtures/paths.json", () => {
    const cases = JSON.parse(
      readFileSync(new URL("../../daemon/test/fixtures/paths.json", import.meta.url), "utf8"),
    ) as { env: Record<string, string>; platform: string; home: string; expected: Record<string, string> }[];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(resolvePaths(c.env, c.platform, c.home)).toEqual(c.expected);
    }
  });
});
