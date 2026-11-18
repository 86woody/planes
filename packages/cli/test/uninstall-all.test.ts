import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUMID_KEY, PROTOCOL_KEY } from "@mc/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import { main } from "../src/main.js";
import type { Io } from "../src/main.js";
import { jsonText } from "../src/installers/json-edit.js";
import { isAlive, readDaemonFile } from "../src/lib/daemon.js";
import { resolveCliPaths } from "../src/lib/paths.js";
import { type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const T = 30_000;

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const manifestOf = (s: Sandbox): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(s.stateDir, "install-manifest.json"), "utf8"));

const claudeSeed = { theme: "dark", hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo", args: ["x"] }] }] } };

describe("mc uninstall --all and the untested uninstalls", () => {
  it("UA-01 --all removes every installed target and restores the seeded files byte for byte", async () => {
    const win = sb;
    const claudeText = jsonText(claudeSeed);
    writeFileSync(path.join(win.claudeDir, "settings.json"), claudeText);
    const codexFile = path.join(win.home, ".codex", "config.toml");
    const codexText = 'model = "gpt-5"\n\n[profiles.a]\nname = "x"\n';
    mkdirSync(path.dirname(codexFile), { recursive: true });
    writeFileSync(codexFile, codexText);
    const bashrc = path.join(win.home, ".bashrc");
    writeFileSync(bashrc, "export A=1\n");

    const winInput = { ...win.input, platform: "win32" as const, onPath: async (cmd: string) => cmd === "code" };
    expect(await install(["claude-code"], win.io, winInput)).toBe(0);
    expect(await install(["copilot"], win.io, winInput)).toBe(0);
    expect(await install(["codex"], win.io, winInput)).toBe(0);
    expect(await install(["shell", "--bash"], win.io, winInput)).toBe(0);
    expect(await install(["uri-handler"], win.io, winInput)).toBe(0);
    expect(await install(["autostart"], win.io, winInput)).toBe(0);
    expect(await install(["vscode"], win.io, winInput)).toBe(0);

    win.calls.length = 0;
    expect(await uninstall(["--all"], win.io, winInput)).toBe(0);
    const text = win.out.join("");
    for (const name of ["vscode", "autostart", "uri-handler", "shell", "codex", "copilot", "claude-code"]) {
      expect(text).toContain(`${name}: removed\n`);
    }
    expect(text).toContain("mission-control removed. Now run: npm rm -g mission-control-desktop\n");

    expect(readFileSync(path.join(win.claudeDir, "settings.json"), "utf8")).toBe(claudeText);
    expect(readFileSync(codexFile, "utf8")).toBe(codexText);
    expect(readFileSync(bashrc, "utf8")).toBe("export A=1\n");
    expect(existsSync(path.join(win.home, ".copilot", "hooks"))).toBe(false);
    expect(Object.keys(manifestOf(win))).toHaveLength(0);

    expect(win.calls).toContainEqual(["reg.exe", "delete", AUMID_KEY, "/f"]);
    expect(win.calls).toContainEqual(["reg.exe", "delete", PROTOCOL_KEY, "/f"]);
    expect(win.calls).toContainEqual(["reg.exe", "delete", RUN_KEY, "/v", "MissionControl", "/f"]);
    expect(win.calls).toContainEqual(["code", "--uninstall-extension", "woody.vscode-bridge"]);
  }, T);

  it("UA-02 uninstall uri-handler: win32 unregisters and removes restore.vbs; linux removes the desktop file; not installed exits 0 with no run calls", async () => {
    const win = sandbox({ platform: "win32" });
    try {
      expect(await install(["uri-handler"], win.io, win.input)).toBe(0);
      const vbs = path.join(win.stateDir, "restore.vbs");
      expect(existsSync(vbs)).toBe(true);
      win.calls.length = 0;
      expect(await uninstall(["uri-handler"], win.io, win.input)).toBe(0);
      expect(win.calls).toContainEqual(["reg.exe", "delete", AUMID_KEY, "/f"]);
      expect(win.calls).toContainEqual(["reg.exe", "delete", PROTOCOL_KEY, "/f"]);
      expect(existsSync(vbs)).toBe(false);
      expect(manifestOf(win)["uri-handler"]).toBeUndefined();
    } finally {
      win.cleanup();
    }

    expect(await install(["uri-handler"], sb.io, sb.input)).toBe(0);
    const desktop = path.join(sb.home, ".local", "share", "applications", "mission-control.desktop");
    expect(existsSync(desktop)).toBe(true);
    sb.calls.length = 0;
    expect(await uninstall(["uri-handler"], sb.io, sb.input)).toBe(0);
    expect(existsSync(desktop)).toBe(false);
    expect(sb.calls).toContainEqual(["update-desktop-database", path.dirname(desktop)]);
    expect(manifestOf(sb)["uri-handler"]).toBeUndefined();

    const fresh = sandbox({ platform: "linux" });
    try {
      expect(await uninstall(["uri-handler"], fresh.io, fresh.input)).toBe(0);
      expect(fresh.out.join("")).toContain("uri-handler: not installed by mc\n");
      expect(fresh.calls).toHaveLength(0);
    } finally {
      fresh.cleanup();
    }
  });

  it("UA-03 uninstall autostart: win32, systemd, xdg and darwin each remove their artefact and the manifest entry", async () => {
    const win = sandbox({ platform: "win32" });
    try {
      expect(await install(["autostart"], win.io, win.input)).toBe(0);
      const vbs = path.join(win.stateDir, "autostart.vbs");
      expect(existsSync(vbs)).toBe(true);
      win.calls.length = 0;
      expect(await uninstall(["autostart"], win.io, win.input)).toBe(0);
      expect(win.calls).toContainEqual(["reg.exe", "delete", RUN_KEY, "/v", "MissionControl", "/f"]);
      expect(existsSync(vbs)).toBe(false);
      expect(manifestOf(win).autostart).toBeUndefined();
    } finally {
      win.cleanup();
    }

    const sys = sandbox({ platform: "linux", hasSystemd: true });
    try {
      expect(await install(["autostart"], sys.io, sys.input)).toBe(0);
      const unit = path.join(sys.home, ".config", "systemd", "user", "mission-control.service");
      expect(existsSync(unit)).toBe(true);
      sys.calls.length = 0;
      expect(await uninstall(["autostart"], sys.io, sys.input)).toBe(0);
      expect(sys.calls).toContainEqual(["systemctl", "--user", "disable", "--now", "mission-control.service"]);
      expect(existsSync(unit)).toBe(false);
      expect(manifestOf(sys).autostart).toBeUndefined();
    } finally {
      sys.cleanup();
    }

    const xdg = sandbox({ platform: "linux", hasSystemd: false });
    try {
      expect(await install(["autostart"], xdg.io, xdg.input)).toBe(0);
      const desktop = path.join(xdg.home, ".config", "autostart", "mission-control.desktop");
      expect(existsSync(desktop)).toBe(true);
      expect(await uninstall(["autostart"], xdg.io, xdg.input)).toBe(0);
      expect(existsSync(desktop)).toBe(false);
      expect(manifestOf(xdg).autostart).toBeUndefined();
    } finally {
      xdg.cleanup();
    }

    const mac = sandbox({ platform: "darwin", uid: 501 });
    try {
      expect(await install(["autostart"], mac.io, mac.input)).toBe(0);
      const plist = path.join(mac.home, "Library", "LaunchAgents", "local.mission-control.plist");
      expect(existsSync(plist)).toBe(true);
      mac.calls.length = 0;
      expect(await uninstall(["autostart"], mac.io, mac.input)).toBe(0);
      expect(mac.calls).toContainEqual(["launchctl", "bootout", "gui/501", plist]);
      expect(existsSync(plist)).toBe(false);
      expect(manifestOf(mac).autostart).toBeUndefined();
    } finally {
      mac.cleanup();
    }
  });

  it("UA-04 a failing vscode uninstall does not stop the other targets; exit 1, nothing purged", async () => {
    const s = sandbox({ platform: "win32" });
    try {
      const input = { ...s.input, onPath: async (cmd: string) => cmd === "code" };
      expect(await install(["claude-code"], s.io, input)).toBe(0);
      expect(await install(["copilot"], s.io, input)).toBe(0);
      expect(await install(["uri-handler"], s.io, input)).toBe(0);
      expect(await install(["vscode"], s.io, input)).toBe(0);
      mkdirSync(s.configDir, { recursive: true });
      writeFileSync(path.join(s.configDir, "config.json"), "{}\n");

      const inner = input.run;
      s.input.run = async (file, args, opts) => {
        if (file === "code" && args[0] === "--uninstall-extension") throw new Error("boom");
        return inner ? inner(file, args, opts) : { code: 0, stdout: "", stderr: "", timedOut: false };
      };
      s.out.length = 0;
      s.errs.length = 0;
      expect(await uninstall(["--all", "--purge"], s.io, s.input)).toBe(1);

      expect(s.out.join("")).toContain("claude-code: removed\n");
      expect(s.out.join("")).toContain("copilot: removed\n");
      expect(s.out.join("")).toContain("uri-handler: removed\n");
      expect(s.errs.join("")).toContain("vscode: failed: boom");
      expect(s.errs.join("")).toContain("purge skipped: fix the failures above and run again");
      expect(s.out.join("")).not.toContain("deleted ");

      const m = manifestOf(s);
      expect(m.vscode).toBeDefined();
      expect(m["claude-code"]).toBeUndefined();
      expect(m["uri-handler"]).toBeUndefined();
      expect(existsSync(s.configDir)).toBe(true);
      expect(existsSync(s.stateDir)).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  it("UA-08 macOS without MC_HOME: --purge deletes the mission-control dir and its state dir, nothing beside it", async () => {
    // noMcHome + darwin: every dir, and the daemon lookup, sit under the temp HOME (never the real machine).
    const s = sandbox({ platform: "darwin", noMcHome: true });
    try {
      const appSupport = path.join(s.home, "Library", "Application Support");
      const configDir = path.join(appSupport, "mission-control");
      const stateDir = path.join(configDir, "state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "daemon.log"), "x\n");
      writeFileSync(path.join(appSupport, "other-app.json"), "{}\n");
      s.out.length = 0;
      s.errs.length = 0;
      expect(await uninstall(["--all", "--purge"], s.io, s.input)).toBe(0);
      expect(s.errs.join("")).not.toContain("refusing");
      expect(s.out.join("")).toContain("daemon: not running\n");
      expect(existsSync(configDir)).toBe(false);
      expect(existsSync(stateDir)).toBe(false);
      expect(readFileSync(path.join(appSupport, "other-app.json"), "utf8")).toBe("{}\n");
    } finally {
      s.cleanup();
    }
  });

  it("UA-09 vscode: a failing editor keeps its manifest entry for a retry; 'is not installed' counts as removed", async () => {
    const s = sandbox({
      platform: "win32",
      onPath: ["code", "cursor"],
      reply: (file, args) => {
        if (args[0] !== "--uninstall-extension") return undefined;
        if (file === "code") return { code: 1, stderr: "Extension 'woody.vscode-bridge' is not installed." };
        if (file === "cursor") return { code: 1, stderr: "cursor: locked" };
        return undefined;
      },
    });
    try {
      const input = { ...s.input, onPath: async (cmd: string) => cmd === "code" || cmd === "cursor" };
      expect(await install(["vscode"], s.io, input)).toBe(0);
      s.errs.length = 0;
      expect(await uninstall(["vscode"], s.io, input)).toBe(1);
      expect(s.errs.join("")).toContain("cursor --uninstall-extension failed: cursor: locked");
      expect(s.errs.join("")).not.toContain("code --uninstall-extension failed");
      const entry = manifestOf(s).vscode as { installedWith: string[] };
      expect(entry.installedWith).toEqual(["cursor"]);
    } finally {
      s.cleanup();
    }
  });

  it("UA-05 --all keeps both dirs and says so; --all --purge deletes them and leaves a file beside them", async () => {
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(await install(["shell", "--bash"], sb.io, sb.input)).toBe(0);
    expect(existsSync(sb.configDir)).toBe(true);
    expect(existsSync(sb.stateDir)).toBe(true);

    expect(await uninstall(["--all"], sb.io, sb.input)).toBe(0);
    expect(sb.out.join("")).toContain(`left in place: ${sb.configDir}\n`);
    expect(sb.out.join("")).toContain(`left in place: ${sb.stateDir}\n`);
    expect(existsSync(sb.configDir)).toBe(true);
    expect(existsSync(sb.stateDir)).toBe(true);

    const keep = path.join(sb.mcHome, "keep.txt");
    writeFileSync(keep, "keep\n");
    sb.out.length = 0;
    expect(await uninstall(["--all", "--purge"], sb.io, sb.input)).toBe(0);
    expect(sb.out.join("")).toContain(`deleted ${sb.configDir}\n`);
    expect(sb.out.join("")).toContain(`deleted ${sb.stateDir}\n`);
    expect(existsSync(sb.configDir)).toBe(false);
    expect(existsSync(sb.stateDir)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });

  it("UA-06 --all stops a daemon started in MC_HOME before any target runs", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MC_HOME: sb.mcHome,
      CLAUDE_CONFIG_DIR: sb.claudeDir,
      MC_PORT: "0",
      MC_PLATFORM: "fake",
      MC_TEST: "1",
    };
    const paths = resolveCliPaths(env);
    const out: string[] = [];
    const errs: string[] = [];
    const io: Io = { out: (s) => out.push(s), err: (s) => errs.push(s), env, cwd: sb.home };
    try {
      expect(await main(["start"], io)).toBe(0);
      expect(existsSync(paths.daemonFile)).toBe(true);
      out.length = 0;
      expect(await uninstall(["--all"], io, sb.input)).toBe(0);
      expect(out[0]).toBe("daemon: stopped\n");
      expect(existsSync(paths.daemonFile)).toBe(false);
    } finally {
      const left = readDaemonFile(paths);
      if (left && isAlive(left.pid)) {
        try {
          process.kill(left.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, T);

  it("UA-07 usage: --purge alone, --all with a target and an extra word exit 2 with the usage line; mc uninstall copilot still works", async () => {
    const usage = "usage: mc uninstall <claude-code|codex|copilot|shell|uri-handler|autostart|vscode> | --all [--purge]";
    for (const argv of [["--purge"], ["--all", "copilot"], ["--all", "--purge", "extra"]]) {
      sb.errs.length = 0;
      expect(await uninstall(argv, sb.io, sb.input)).toBe(2);
      expect(sb.errs.join("")).toContain(usage);
    }

    expect(await install(["copilot"], sb.io, sb.input)).toBe(0);
    expect(manifestOf(sb)["copilot-cli"]).toBeDefined();
    expect(await uninstall(["copilot"], sb.io, sb.input)).toBe(0);
    expect(manifestOf(sb)["copilot-cli"]).toBeUndefined();
  });
});
