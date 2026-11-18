import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import { jsonText } from "../src/installers/json-edit.js";
import { launcherHook, NODE, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const NODE_FWD = NODE.replace(/\\/g, "/");
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

let sb: Sandbox;
let settings: string;
beforeEach(() => {
  sb = sandbox();
  settings = path.join(sb.claudeDir, "settings.json");
});
afterEach(() => sb.cleanup());

const backups = (): string[] => readdirSync(sb.claudeDir).filter((f) => f.startsWith("settings.json.mc-backup-"));

describe("claude-code installer", () => {
  it("IC-01 install adds one group per event of claude-hooks.md with the exec-form hook object (command = node path, args = [hook js, claude-code])", async () => {
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(Object.keys(s.hooks).sort()).toEqual([...EVENTS].sort());
    for (const e of EVENTS) {
      expect(s.hooks[e]).toHaveLength(1);
      expect(s.hooks[e][0].matcher).toBe("");
      expect(s.hooks[e][0].hooks).toEqual([
        {
          type: "command",
          command: NODE_FWD,
          args: [launcherHook(sb), "claude-code"],
          async: e !== "SessionEnd",
          timeout: e === "SessionEnd" ? 2 : 5,
        },
      ]);
    }
  });

  it("IC-02 existing user hooks are kept in order and untouched", async () => {
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] };
    const other = { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/stop.sh" }] };
    writeFileSync(settings, jsonText({ model: "opus", hooks: { Stop: [other], PreToolUse: [userGroup] } }));
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(Object.keys(s)).toEqual(["model", "hooks"]);
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual([userGroup]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0]).toEqual(other);
    expect(s.hooks.Stop[1].hooks[0].command).toBe(NODE_FWD);
  });

  it("IC-03 install twice adds nothing the second time", async () => {
    writeFileSync(settings, jsonText({ model: "opus" }));
    await install(["claude-code"], sb.io, sb.input);
    const first = readFileSync(settings, "utf8");
    const callsAfterFirst = sb.calls.length;
    expect(backups()).toHaveLength(1);
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(first);
    expect(backups()).toHaveLength(1);
    expect(sb.calls.length).toBe(callsAfterFirst);
    expect(JSON.parse(first).hooks.Stop).toHaveLength(1);

    // Regression: a failed URI handler leaves the hooks in place, exits 0 with a warning, records no
    // uri-handler entry, and the next run retries it.
    let fail = true;
    const f = sandbox({ platform: "linux", noMcHome: true, reply: (file) => (fail && file === "xdg-mime" ? { code: 1, stderr: "no xdg" } : undefined) });
    try {
      expect(await install(["claude-code"], f.io, f.input)).toBe(0);
      expect(f.errs.join("")).toContain("URI handler failed");
      expect(JSON.parse(readFileSync(path.join(f.claudeDir, "settings.json"), "utf8")).hooks.Stop).toHaveLength(1);
      const m1 = JSON.parse(readFileSync(path.join(f.stateDir, "install-manifest.json"), "utf8"));
      expect(m1["claude-code"]).toBeDefined();
      expect(m1["uri-handler"]).toBeUndefined();
      fail = false;
      expect(await install(["claude-code"], f.io, f.input)).toBe(0);
      const m2 = JSON.parse(readFileSync(path.join(f.stateDir, "install-manifest.json"), "utf8"));
      expect(m2["uri-handler"]).toBeDefined();
    } finally {
      f.cleanup();
    }
  });

  it("IC-04 a backup file is written before the first change", async () => {
    const original = jsonText({ model: "opus" });
    writeFileSync(settings, original);
    await install(["claude-code"], sb.io, sb.input);
    const found = backups();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^settings\.json\.mc-backup-20261112093005$/);
    expect(readFileSync(path.join(sb.claudeDir, found[0] as string), "utf8")).toBe(original);
  });

  it("IC-05 invalid settings JSON: exit 1, file unchanged", async () => {
    const broken = "{ not json";
    writeFileSync(settings, broken);
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(1);
    expect(readFileSync(settings, "utf8")).toBe(broken);
    expect(sb.errs.join("")).toContain("not valid JSON");
    expect(existsSync(path.join(sb.stateDir, "install-manifest.json"))).toBe(false);
  });

  it("IC-06 uninstall removes exactly the recorded entries and empty arrays, leaving other keys", async () => {
    const original = jsonText({
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/x.sh" }] }] },
    });
    writeFileSync(settings, original);
    await install(["claude-code"], sb.io, sb.input);
    expect(await uninstall(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(original);
    const manifest = JSON.parse(readFileSync(path.join(sb.stateDir, "install-manifest.json"), "utf8"));
    expect(manifest["claude-code"]).toBeUndefined();
  });

  it("IC-07 --dry-run prints a diff and writes nothing", async () => {
    const original = jsonText({ model: "opus" });
    writeFileSync(settings, original);
    expect(await install(["claude-code", "--dry-run"], sb.io, sb.input)).toBe(0);
    const printed = sb.out.join("");
    expect(printed).toMatch(/^\+/m);
    expect(printed).toContain("SessionEnd");
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(backups()).toHaveLength(0);
    expect(sb.calls).toHaveLength(0);
    expect(existsSync(path.join(sb.stateDir, "install-manifest.json"))).toBe(false);
  });

  it("IC-08 SessionEnd is the only synchronous entry, with timeout 2", async () => {
    await install(["claude-code"], sb.io, sb.input);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    const sync = EVENTS.filter((e) => s.hooks[e][0].hooks[0].async === false);
    expect(sync).toEqual(["SessionEnd"]);
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(2);
    for (const e of EVENTS.filter((x) => x !== "SessionEnd")) {
      expect(s.hooks[e][0].hooks[0].timeout).toBe(5);
    }
  });
});
