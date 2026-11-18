import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import { COPILOT_EVENTS } from "../src/installers/copilot.js";
import { launcherHook, NODE, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const NODE_FWD = NODE.replace(/\\/g, "/");

let sb: Sandbox;
let hooksDir: string;
let file: string;
beforeEach(() => {
  sb = sandbox();
  const copilotHome = path.join(sb.home, "copilot-home");
  sb.input.env!.COPILOT_HOME = copilotHome; // the injectable location; the real ~/.copilot is never touched
  hooksDir = path.join(copilotHome, "hooks");
  file = path.join(hooksDir, "mission-control.json");
});
afterEach(() => sb.cleanup());

type Doc = { version: number; hooks: Record<string, { timeoutSec: number }[]> };
const read = (): Doc => JSON.parse(readFileSync(file, "utf8"));
const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(path.join(sb.stateDir, "install-manifest.json"), "utf8"));
const backups = (): string[] => (existsSync(hooksDir) ? readdirSync(hooksDir).filter((f) => f.includes(".mc-backup-")) : []);

describe("mc install copilot", () => {
  it("CP-10 install writes one exec hook per event into mission-control.json and records the manifest", async () => {
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    const doc = read();
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.hooks)).toEqual(COPILOT_EVENTS.map((e) => e.event));
    expect(doc.hooks.Stop).toEqual([{ type: "command", exec: NODE_FWD, args: [launcherHook(sb), "copilot-cli", "Stop"], timeoutSec: 5 }]);
    expect(doc.hooks.SessionEnd[0].timeoutSec).toBe(2);
    expect(manifest()["copilot-cli"]).toMatchObject({ hooksPath: file, exec: NODE_FWD, hookJs: launcherHook(sb) });
    expect(existsSync(path.join(sb.home, ".copilot"))).toBe(false);
  });

  it("CP-11 a second install changes nothing and makes no backup; --dry-run writes nothing", async () => {
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    const first = readFileSync(file, "utf8");
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(backups()).toHaveLength(0);
    sb.cleanup();
    sb = sandbox();
    sb.input.env!.COPILOT_HOME = path.join(sb.home, "ch");
    expect(await install(["copilot", "--dry-run"], sb.io, sb.input)).toBe(0);
    expect(existsSync(path.join(sb.home, "ch"))).toBe(false);
  });

  it("CP-12 existing hooks in the file survive install (with a backup) and uninstall removes only ours", async () => {
    mkdirSync(hooksDir, { recursive: true });
    const mine = { type: "command", bash: "./audit.sh" };
    const original = { version: 1, disableAllHooks: false, hooks: { Stop: [mine], preToolUse: [mine] } };
    writeFileSync(file, JSON.stringify(original, null, 2));
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(backups()).toHaveLength(1);
    expect(read().hooks.Stop).toHaveLength(2);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(read()).toEqual(original);
    expect(manifest()["copilot-cli"]).toBeUndefined();
    // The backup this install made is deleted; the hooks dir stays because the user created it.
    expect(backups()).toHaveLength(0);
    expect(existsSync(hooksDir)).toBe(true);
    // A user's own backup and files in the same directory are never deleted by uninstall.
    const userBackup = path.join(hooksDir, "mission-control.json.mc-backup-20000101000000");
    const userFile = path.join(hooksDir, "other.json");
    writeFileSync(userBackup, "{}");
    writeFileSync(userFile, "{}");
    writeFileSync(file, JSON.stringify({ version: 1, hooks: { Stop: [mine] } }));
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(backups()).toHaveLength(2);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(backups()).toEqual([path.basename(userBackup)]);
    expect(existsSync(userFile)).toBe(true);
  });

  it("CP-13 uninstall deletes the file when only our entries were in it, and is a no-op when not installed", async () => {
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(sb.out.join("")).toContain("not installed by mc");
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(existsSync(file)).toBe(false);
    // The installer created the hooks directory, and it is empty now: it goes too.
    expect(existsSync(hooksDir)).toBe(false);
    // A hooks directory the installer did not create stays, even when it is empty.
    mkdirSync(hooksDir, { recursive: true });
    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(existsSync(hooksDir)).toBe(true);
    expect(readdirSync(hooksDir)).toEqual([]);
  });

  it("CP-14 malformed files are refused with exit 1 and left byte-for-byte unchanged", async () => {
    mkdirSync(hooksDir, { recursive: true });
    const cases = [
      "{not json",
      "[]",
      JSON.stringify({ version: 2, hooks: {} }),
      JSON.stringify({ version: 1, hooks: [] }),
      JSON.stringify({ version: 1, hooks: { Stop: {} } }),
    ];
    for (const text of cases) {
      writeFileSync(file, text);
      expect(await install(["copilot"], sb.io, sb.input), text).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    expect(backups()).toHaveLength(0);
    expect(sb.errs.join("")).toContain("No change was written");
  });
});
