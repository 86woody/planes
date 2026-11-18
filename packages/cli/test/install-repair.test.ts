import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import type { CtxInput } from "../src/installers/manifest.js";
import { jsonText } from "../src/installers/json-edit.js";
import { launcherPaths, readLauncherTarget } from "../src/installers/launcher.js";
import { LAYOUT, launcherHook, NODE, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const NODE_FWD = NODE.replace(/\\/g, "/");
const NODE_A = "C:\\nvm\\v20\\node.exe";
const OLD = "/old/clone/packages/hook/dist/mc-hook.js";
const OLD_NODE = "/old/node/bin/node";

const CLAUDE_EVENTS = [
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
const COPILOT_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function make(opts?: Parameters<typeof sandbox>[0]): Sandbox {
  const sb = sandbox(opts);
  cleanups.push(sb.cleanup);
  return sb;
}

// Parsed JSON in these tests is read by key path; the shape is checked by the assertions themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const settingsFile = (sb: Sandbox): string => path.join(sb.claudeDir, "settings.json");
const manifestFile = (sb: Sandbox): string => path.join(sb.stateDir, "install-manifest.json");
const backups = (sb: Sandbox): string[] => readdirSync(sb.claudeDir).filter((f) => f.startsWith("settings.json.mc-backup-"));

const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8"));

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, jsonText(value));
}

function writeManifest(sb: Sandbox, value: unknown): void {
  writeJson(manifestFile(sb), value);
}

/** A second install: another node and another MC_HOME under the same temp root (same CLAUDE_CONFIG_DIR and HOME). */
function second(sb: Sandbox, nodePath: string, mcHomeName: string): Partial<CtxInput> {
  const env = { ...(sb.input.env ?? {}), MC_HOME: path.join(path.dirname(sb.mcHome), mcHomeName) };
  return { ...sb.input, nodePath, env };
}

const stateOf = (sb: Sandbox, mcHomeName: string): string => path.join(path.dirname(sb.mcHome), mcHomeName, "state");

const userHook = { type: "command", command: "user-tool" };
const userGroup = { matcher: "u", hooks: [userHook] };

function claudeObj(hook: string, node: string, async = true, timeout = 5): Record<string, unknown> {
  return { type: "command", command: node, args: [hook, "claude-code"], async, timeout };
}

function claudeGroup(hook: string, node: string): Record<string, unknown> {
  return { matcher: "", hooks: [claudeObj(hook, node)] };
}

function copilotObj(exec: string, hook: string, event: string, timeoutSec = 5): Record<string, unknown> {
  return { type: "command", exec, args: [hook, "copilot-cli", event], timeoutSec };
}

/** Counts every claude-code hook object that the identification rule matches, across all events. */
function countClaudeMc(settings: Json): number {
  let n = 0;
  for (const groups of Object.values(settings.hooks as Record<string, Json[]>)) {
    for (const g of groups) {
      for (const h of g.hooks as Json[]) {
        if (Array.isArray(h.args) && String(h.args[0]).endsWith("mc-hook.js") && h.args[1] === "claude-code") n++;
      }
    }
  }
  return n;
}

const copilotHooksFile = (copilotDir: string): string => path.join(copilotDir, "hooks", "mission-control.json");

describe("claude-code repair in place", () => {
  it("RP-01 claude-code: install from node A and state A, then node B and state B, leaves one hook object per event, pointing at B", async () => {
    const sb = make();
    expect(await install(["claude-code"], sb.io, second(sb, NODE_A, "a"))).toBe(0);
    sb.out.length = 0;
    expect(await install(["claude-code"], sb.io, second(sb, NODE, "b"))).toBe(0);
    const stateB = stateOf(sb, "b");
    const want = [launcherHook({ stateDir: stateB }), "claude-code"];
    const s = readJson(settingsFile(sb));
    for (const ev of CLAUDE_EVENTS) {
      expect(s.hooks[ev]).toHaveLength(1);
      expect(s.hooks[ev][0].hooks).toHaveLength(1);
      expect(s.hooks[ev][0].hooks[0].command).toBe(NODE_FWD);
      expect(s.hooks[ev][0].hooks[0].args).toEqual(want);
    }
    expect(countClaudeMc(s)).toBe(9);
    const manifest = readJson(path.join(stateB, "install-manifest.json"));
    expect(manifest["claude-code"].command).toBe(NODE_FWD);
    expect(manifest["claude-code"].args).toEqual(want);
    expect(sb.out.join("")).toContain("repaired 9");
  });

  it("RP-02 claude-code: seeded duplicate mc objects collapse to the first one, which is repaired in place with its position kept", async () => {
    const sb = make();
    const userGroup2 = { matcher: "x", hooks: [userHook, claudeObj(OLD, OLD_NODE)] };
    writeJson(settingsFile(sb), {
      hooks: { Stop: [claudeGroup(OLD, OLD_NODE), userGroup, claudeGroup(OLD, OLD_NODE), userGroup2] },
    });
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    const s = readJson(settingsFile(sb));
    expect(s.hooks.Stop).toEqual([
      {
        matcher: "",
        hooks: [{ type: "command", command: NODE_FWD, args: [launcherHook(sb), "claude-code"], async: true, timeout: 5 }],
      },
      userGroup,
      { matcher: "x", hooks: [userHook] },
    ]);
    for (const ev of CLAUDE_EVENTS.filter((e) => e !== "Stop")) expect(s.hooks[ev]).toHaveLength(1);
    expect(sb.out.join("")).toContain("removed 2 duplicate");
  });

  it("RP-03 claude-code: a repaired file is stable, a third install changes nothing and makes no second backup", async () => {
    const sb = make();
    const userGroup2 = { matcher: "x", hooks: [userHook, claudeObj(OLD, OLD_NODE)] };
    writeJson(settingsFile(sb), {
      hooks: { Stop: [claudeGroup(OLD, OLD_NODE), userGroup, claudeGroup(OLD, OLD_NODE), userGroup2] },
    });
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    const once = readFileSync(settingsFile(sb), "utf8");
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(settingsFile(sb), "utf8")).toBe(once);
    expect(backups(sb)).toHaveLength(1);
  });

  it("RP-04 claude-code: uninstall after a manifest mismatch removes every mc object from every event and leaves the user file", async () => {
    const sb = make();
    const file = settingsFile(sb);
    const userGroup2 = { matcher: "x", hooks: [userHook, claudeObj(OLD, OLD_NODE)] };
    const userPre = { matcher: "p", hooks: [userHook] };
    writeJson(file, {
      hooks: {
        Stop: [claudeGroup(OLD, OLD_NODE), userGroup, claudeGroup(OLD, OLD_NODE), userGroup2],
        PreToolUse: [userPre],
        SubagentStop: [claudeGroup(OLD, OLD_NODE)],
      },
    });
    writeManifest(sb, {
      "claude-code": {
        settingsPath: file,
        events: ["Stop"],
        command: "/other/node",
        args: ["/other/mc-hook.js", "claude-code"],
      },
    });
    expect(await uninstall(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      jsonText({ hooks: { Stop: [userGroup, { matcher: "x", hooks: [userHook] }], PreToolUse: [userPre] } }),
    );
    expect(readJson(manifestFile(sb))["claude-code"]).toBeUndefined();
  });

  it("RP-05 claude-code: user hooks that merely look similar are never matched", async () => {
    const sb = make();
    const lookalikes = [
      { type: "command", command: "x", args: ["/p/mc-hook.js", "other"] },
      { args: ["/p/mc-hook.js", "claude-code", "extra"] },
      { command: "mc-hook.js" },
    ];
    const userLike = { matcher: "", hooks: lookalikes };
    writeJson(settingsFile(sb), { hooks: { Stop: [userLike] } });
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readJson(settingsFile(sb)).hooks.Stop[0].hooks).toEqual(lookalikes);
    expect(await uninstall(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(readJson(settingsFile(sb)).hooks.Stop).toEqual([userLike]);
  });

  it("RP-06 claude-code: --dry-run on a stale file prints the repair diff, writes nothing and creates no launchers", async () => {
    const sb = make();
    const file = settingsFile(sb);
    writeJson(file, { hooks: Object.fromEntries(CLAUDE_EVENTS.map((ev) => [ev, [claudeGroup(OLD, OLD_NODE)]])) });
    const before = readFileSync(file, "utf8");
    expect(await install(["claude-code", "--dry-run"], sb.io, sb.input)).toBe(0);
    const lines = sb.out.join("").split("\n");
    expect(lines.some((l) => l.startsWith("-"))).toBe(true);
    expect(lines.some((l) => l.startsWith("+"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(path.join(sb.stateDir, "bin"))).toBe(false);
    expect(existsSync(manifestFile(sb))).toBe(false);
  });
});

describe("copilot repair in place", () => {
  it("RP-07 copilot: install from node A then node B leaves one hook per event, pointing at B", async () => {
    const sb = make();
    const copilotDir = path.join(sb.home, "copilot-home");
    sb.input.env = { ...(sb.input.env ?? {}), COPILOT_HOME: copilotDir };
    expect(await install(["copilot"], sb.io, second(sb, NODE_A, "a"))).toBe(0);
    expect(await install(["copilot"], sb.io, second(sb, NODE, "b"))).toBe(0);
    const stateB = stateOf(sb, "b");
    const s = readJson(copilotHooksFile(copilotDir));
    for (const ev of COPILOT_EVENTS) {
      expect(s.hooks[ev]).toEqual([
        {
          type: "command",
          exec: NODE_FWD,
          args: [launcherHook({ stateDir: stateB }), "copilot-cli", ev],
          timeoutSec: ev === "SessionEnd" ? 2 : 5,
        },
      ]);
    }
    const manifest = readJson(path.join(stateB, "install-manifest.json"));
    expect(manifest["copilot-cli"].hookJs).toBe(launcherHook({ stateDir: stateB }));
  });

  it("RP-08 copilot: seeded duplicates collapse and user entries stay", async () => {
    const sb = make();
    const copilotDir = path.join(sb.home, "copilot-home");
    sb.input.env = { ...(sb.input.env ?? {}), COPILOT_HOME: copilotDir };
    writeJson(copilotHooksFile(copilotDir), {
      version: 1,
      hooks: {
        Stop: [copilotObj(OLD_NODE, OLD, "Stop"), userHook, copilotObj(OLD_NODE, OLD, "Stop")],
        preToolUse: [userHook],
      },
    });
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    const s = readJson(copilotHooksFile(copilotDir));
    expect(s.hooks.Stop).toEqual([copilotObj(NODE_FWD, launcherHook(sb), "Stop"), userHook]);
    expect(s.hooks.preToolUse).toEqual([userHook]);
    expect(sb.out.join("")).toContain("removed 1 duplicate");
  });

  it("RP-09 copilot: uninstall after a manifest mismatch removes every mc entry and keeps user entries", async () => {
    const sb = make();
    const copilotDir = path.join(sb.home, "copilot-home");
    sb.input.env = { ...(sb.input.env ?? {}), COPILOT_HOME: copilotDir };
    const file = copilotHooksFile(copilotDir);
    const recorded = {
      "copilot-cli": {
        hooksPath: file,
        events: ["Stop"],
        exec: "/other/node",
        hookJs: "/other/mc-hook.js",
        createdHooksDir: false,
        backups: [],
      },
    };

    // Case 1: mc entries under Stop and SessionEnd next to a user entry under Stop.
    writeJson(file, {
      version: 1,
      hooks: {
        Stop: [copilotObj(OLD_NODE, OLD, "Stop"), userHook],
        SessionEnd: [copilotObj(OLD_NODE, OLD, "SessionEnd", 2)],
      },
    });
    writeManifest(sb, recorded);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    const s = readJson(file);
    expect(s.version).toBe(1);
    expect(s.hooks).toEqual({ Stop: [userHook] });

    // Case 2: only mc entries, so the file is deleted.
    writeJson(file, {
      version: 1,
      hooks: {
        Stop: [copilotObj(OLD_NODE, OLD, "Stop")],
        SessionEnd: [copilotObj(OLD_NODE, OLD, "SessionEnd", 2)],
      },
    });
    writeManifest(sb, recorded);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe("codex repair in place", () => {
  it("RP-10 codex: a plain mc notify line at an old path is rewritten in place, not wrapped", async () => {
    const sb = make();
    const file = path.join(sb.home, ".codex", "config.toml");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `model = "x"\nnotify = ["${OLD_NODE}", "${OLD}", "codex"]\n[a]\nk = 1\n`);
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`model = "x"\nnotify = ["${NODE_FWD}", "${launcherHook(sb)}", "codex"]\n[a]\nk = 1\n`);
    expect(text.includes("--chain")).toBe(false);
    const entry = readJson(manifestFile(sb)).codex;
    expect(entry.line).toBe(`notify = ["${NODE_FWD}", "${launcherHook(sb)}", "codex"]`);
    expect(entry.original).toBeUndefined();
  });

  it("RP-11 codex: a wrapped mc line is rewritten in place, keeps its --chain and never nests", async () => {
    const sb = make();
    const file = path.join(sb.home, ".codex", "config.toml");
    const b64 = Buffer.from(JSON.stringify(["C:/Program Files/cu.exe", "--flag"])).toString("base64url");
    const seedLine = `notify = ["/old/node/bin/node", "/old/mc-hook.js", "codex", "--chain", "${b64}"]`;
    const original = ['notify = ["C:/Program Files/cu.exe", "--flag"]'];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${seedLine}\n`);
    writeManifest(sb, { codex: { path: file, line: seedLine, original, eol: "\n" } });

    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(`notify = ["${NODE_FWD}", "${launcherHook(sb)}", "codex", "--chain", "${b64}"]\n`);
    expect(text.split("--chain")).toHaveLength(2);
    const entry = readJson(manifestFile(sb)).codex;
    expect(entry.original).toEqual(original);
    expect(entry.eol).toBe("\n");

    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("RP-12 codex: uninstall after the line was rewritten out of band restores the original", async () => {
    const sb = make();
    const file = path.join(sb.home, ".codex", "config.toml");
    const b64 = Buffer.from(JSON.stringify(["C:/Program Files/cu.exe", "--flag"])).toString("base64url");
    const seedLine = `notify = ["/old/node/bin/node", "/old/mc-hook.js", "codex", "--chain", "${b64}"]`;
    const original = ['notify = ["C:/Program Files/cu.exe", "--flag"]'];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${seedLine}\n`);
    writeManifest(sb, { codex: { path: file, line: seedLine, original, eol: "\n" } });
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);

    // Edited by hand after the install: the manifest's recorded line no longer matches, the identification rule still does.
    writeFileSync(file, `notify = ["/third/node", "/third/mc-hook.js", "codex", "--chain", "${b64}"]\n`);
    expect(await uninstall(["codex"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('notify = ["C:/Program Files/cu.exe", "--flag"]\n');

    // Plain case: a bare mc line edited by hand is removed.
    writeFileSync(file, `model = "x"\nnotify = ["/third/node", "/third/mc-hook.js", "codex"]\n[a]\nk = 1\n`);
    writeManifest(sb, { codex: { path: file, line: "notify = []" } });
    expect(await uninstall(["codex"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('model = "x"\n[a]\nk = 1\n');
  });
});

describe("launchers and uri-handler", () => {
  it("RP-13 install claude-code, copilot and codex each write the launchers before the user file", async () => {
    const claude = make();
    expect(await install(["claude-code"], claude.io, claude.input)).toBe(0);
    expect(readLauncherTarget(launcherPaths(claude.stateDir).hookJs)).toBe(LAYOUT.hookJs);

    const copilot = make();
    copilot.input.env = { ...(copilot.input.env ?? {}), COPILOT_HOME: path.join(copilot.home, "copilot-home") };
    expect(await install(["copilot"], copilot.io, copilot.input)).toBe(0);
    expect(readLauncherTarget(launcherPaths(copilot.stateDir).hookJs)).toBe(LAYOUT.hookJs);

    const codex = make();
    expect(await install(["codex"], codex.io, codex.input)).toBe(0);
    expect(readLauncherTarget(launcherPaths(codex.stateDir).hookJs)).toBe(LAYOUT.hookJs);
  });

  it("RP-14 claude-code skips its automatic uri-handler step when MC_HOME is set, and runs it when it is not", async () => {
    const win = make({ platform: "win32" });
    expect(await install(["claude-code"], win.io, win.input)).toBe(0);
    expect(win.out.join("")).toContain("uri-handler skipped (MC_HOME set)\n");
    expect(win.calls.some((c) => c[0]?.toLowerCase() === "reg.exe")).toBe(false);
    expect(readJson(manifestFile(win))["uri-handler"]).toBeUndefined();

    const linux = make({ platform: "linux" });
    expect(await install(["claude-code"], linux.io, linux.input)).toBe(0);
    expect(linux.out.join("")).toContain("uri-handler skipped (MC_HOME set)\n");
    expect(linux.calls.some((c) => c[0] === "xdg-mime")).toBe(false);
    expect(await install(["uri-handler"], linux.io, linux.input)).toBe(0);
    expect(linux.calls.some((c) => c[0] === "xdg-mime")).toBe(true);

    const unset = make({ platform: "linux", noMcHome: true });
    expect(await install(["claude-code"], unset.io, unset.input)).toBe(0);
    expect(unset.calls.some((c) => c[0] === "xdg-mime")).toBe(true);
    expect(readJson(manifestFile(unset))["uri-handler"]).toBeDefined();
    expect(unset.out.join("")).not.toContain("skipped");

    const mac = make({ platform: "darwin" });
    expect(await install(["claude-code"], mac.io, mac.input)).toBe(0);
    expect(mac.out.join("")).not.toContain("skipped");
  });
});
