import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/main.js";
import { runChecks } from "../src/commands/doctor.js";
import { checksFor, notificationsOutcome } from "../src/lib/doctor-checks.js";
import type { DoctorCheck } from "../src/lib/doctor-checks.js";

let home: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let io: Io;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mc-doctor-"));
  env = { MC_HOME: home, MC_PLATFORM: "fake", MC_TEST: "1" };
  out = [];
  io = { out: (s) => out.push(s), err: (s) => out.push(s), env, cwd: process.cwd() };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const labels = (checks: DoctorCheck[]): string => checks.map((c) => c.label).join("\n").toLowerCase();

describe("mc doctor", () => {
  it("DR-01 doctor exits 0 when every required check is ok", async () => {
    const checks: DoctorCheck[] = [
      { id: "a", label: "Alpha", required: true, fix: "fix a", run: async () => "ok" },
      { id: "b", label: "Beta", required: false, fix: "fix b", run: async () => "warn" },
    ];
    expect(await runChecks(checks, io)).toBe(0);
    expect(out.join("\n")).toContain("OK Alpha  fix a");
  });

  it("DR-02 doctor exits 1 and prints MISSING with the fix text when a required check fails", async () => {
    const checks: DoctorCheck[] = [
      { id: "a", label: "Alpha", required: true, fix: "install alpha now", run: async () => "missing" },
    ];
    expect(await runChecks(checks, io)).toBe(1);
    expect(out.join("\n")).toContain("MISSING Alpha  install alpha now");
  });

  it("DR-03 windows checks include PowerShell 5.1, AUMID, protocol, notifications enabled", () => {
    const text = labels(checksFor("win32", env, home));
    expect(text).toContain("powershell 5.1");
    expect(text).toContain("aumid");
    expect(text).toContain("protocol");
    expect(text).toContain("notifications enabled");
  });

  it("DR-04 macos checks include Automation, Accessibility and the responsible process", () => {
    const text = labels(checksFor("darwin", env, home));
    expect(text).toContain("automation");
    expect(text).toContain("accessibility");
    expect(text).toContain("responsible process");
  });

  it("DR-05 linux checks follow the selected backend's tools", () => {
    const x11 = checksFor("linux", { ...env, DISPLAY: ":0" }, home).map((c) => c.id);
    expect(x11).toContain("wmctrl");
    expect(x11).toContain("xprop");
    expect(x11).not.toContain("swaymsg");

    const sway = checksFor("linux", { ...env, SWAYSOCK: "/run/sway.sock" }, home).map((c) => c.id);
    expect(sway).toContain("swaymsg");
    expect(sway).not.toContain("wmctrl");
  });

  it("DR-06 doctor reports whether the Claude Code hooks are installed", async () => {
    const claudeDir = path.join(home, "claude");
    mkdirSync(claudeDir, { recursive: true });
    const hooks = checksFor("linux", { ...env, CLAUDE_CONFIG_DIR: claudeDir }, home).find((c) => c.id === "claude-hooks");
    expect(hooks).toBeDefined();
    expect(await hooks!.run()).toBe("warn");

    writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: ["/x/packages/hook/dist/mc-hook.js", "claude-code"] }] }] } }),
    );
    expect(await hooks!.run()).toBe("ok");
  });
});

describe("notifications check (T103, D-50)", () => {
  it("DR-07 a missing Enabled value is on; Enabled 0x0 warns; Enabled 0x1 is on", () => {
    expect(notificationsOutcome({ code: 1, stdout: "" })).toBe("ok");
    const key = "HKEY_CURRENT_USER/Notifications/Settings/X\r\n";
    expect(notificationsOutcome({ code: 0, stdout: `\r\n${key}    Enabled    REG_DWORD    0x0\r\n` })).toBe("warn");
    expect(notificationsOutcome({ code: 0, stdout: `\r\n${key}    Enabled    REG_DWORD    0x1\r\n` })).toBe("ok");
  });
});
