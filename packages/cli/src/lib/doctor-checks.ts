import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Layout, layout } from "@mc/platform/layout";
import { resolveCliPaths } from "./paths.js";
import { findRunning } from "./daemon.js";
import { koffiRequire } from "./system.js";
import { parseNotify } from "../installers/codex.js";
import { readLauncherTarget } from "../installers/launcher.js";

export type Status = "ok" | "missing" | "warn";
export type Outcome = Status | { status: Status; detail: string };

export interface DoctorCheck {
  id: string;
  label: string;
  required: boolean;
  run(): Promise<Outcome>;
  fix: string;
}

interface Probe {
  code: number;
  stdout: string;
  stderr: string;
}

/** Never rejects: a missing binary is code -1. */
function probe(file: string, args: string[], timeoutMs = 5000): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const hasCommand = async (cmd: string): Promise<boolean> => (await probe("sh", ["-c", `command -v ${cmd}`])).code === 0;

const okIf = (cond: boolean, failed: Status = "warn"): Status => (cond ? "ok" : failed);

function powershellPath(env: NodeJS.ProcessEnv): string {
  return path.join(env["SystemRoot"] || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const slashes = (p: string): string => p.replace(/\\/g, "/");

/** Launcher problems for one file the install wrote; empty when it names `expected` and that target exists. */
function launcherProblems(label: string, file: string, expected: string): string[] {
  if (!existsSync(file)) return [`${label}: launcher missing ${file}`];
  const target = readLauncherTarget(file);
  if (target === null) return [`${label}: ${file} is not a launcher`];
  if (target !== expected) return [`${label}: launcher targets ${target}, this install is ${expected}`];
  if (!existsSync(target)) return [`${label}: launcher target missing ${target}`];
  return [];
}

function readJson(label: string, file: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    problems.push(`${label}: ${file} is not valid JSON`);
    return undefined;
  }
}

/** The mc hook objects of a Claude Code settings file (claude-hooks.md 2) or a Copilot hooks file (D-36). */
function hookProblems(label: string, file: string, lay: Layout, claude: boolean, problems: string[]): void {
  const doc = readJson(label, file, problems);
  if (!isObj(doc) || !isObj(doc["hooks"])) return;
  for (const [event, groups] of Object.entries(doc["hooks"])) {
    if (!Array.isArray(groups)) continue;
    const mine: Obj[] = [];
    for (const group of groups) {
      // Claude Code nests hook objects in matcher groups; Copilot keeps them flat under the event.
      const objects = claude ? (isObj(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []) : [group];
      for (const h of objects) {
        if (!isObj(h) || !Array.isArray(h["args"])) continue;
        const args = h["args"] as unknown[];
        const want = claude ? 2 : 3;
        const adapter = claude ? "claude-code" : "copilot-cli";
        if (args.length !== want || typeof args[0] !== "string" || !slashes(args[0]).endsWith("mc-hook.js") || args[1] !== adapter) continue;
        mine.push(h);
      }
    }
    if (mine.length > 1) problems.push(`${label}: ${mine.length} mc hooks for ${event}`);
    for (const h of mine) {
      const args = h["args"] as string[];
      const command = String(claude ? h["command"] : h["exec"]);
      if (!existsSync(command)) problems.push(`${label}: command missing ${command}`);
      problems.push(...launcherProblems(label, args[0] as string, lay.hookJs));
    }
  }
}

/** `mc doctor` hook-paths (D-42): reads the manifest and the live files it names, never writes. */
function hookPathOutcome(stateDir: string, lay: Layout): Outcome {
  const manifestFile = path.join(stateDir, "install-manifest.json");
  const nothing: Outcome = { status: "ok", detail: "nothing installed" };
  if (!existsSync(manifestFile)) return nothing;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
  } catch {
    return { status: "warn", detail: "install-manifest.json is not valid JSON" };
  }
  if (!isObj(manifest) || Object.keys(manifest).length === 0) return nothing;

  const problems: string[] = [];
  const entry = (key: string): Obj | undefined => (isObj(manifest[key]) ? (manifest[key] as Obj) : undefined);

  const claude = entry("claude-code");
  if (claude && typeof claude["settingsPath"] === "string" && existsSync(claude["settingsPath"])) {
    hookProblems("claude-code", claude["settingsPath"], lay, true, problems);
  }
  const copilot = entry("copilot-cli");
  if (copilot && typeof copilot["hooksPath"] === "string" && existsSync(copilot["hooksPath"])) {
    hookProblems("copilot-cli", copilot["hooksPath"], lay, false, problems);
  }

  const codex = entry("codex");
  if (codex && typeof codex["path"] === "string" && existsSync(codex["path"])) {
    const lines = readFileSync(codex["path"], "utf8").split("\n");
    const index = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
    const notify = index < 0 ? null : parseNotify(lines, index);
    if (notify && slashes(notify.argv[1] ?? "").endsWith("mc-hook.js") && notify.argv[2] === "codex") {
      const [node, hook] = notify.argv;
      if (node !== undefined && !existsSync(node)) problems.push(`codex: command missing ${node}`);
      if (hook !== undefined) problems.push(...launcherProblems("codex", hook, lay.hookJs));
    }
  }

  const shell = entry("shell");
  if (shell && typeof shell["envFile"] === "string" && existsSync(shell["envFile"])) {
    const lines = readFileSync(shell["envFile"], "utf8").split("\n");
    const value = (key: string): string | undefined => lines.find((l) => l.startsWith(key))?.slice(key.length).replace(/\r$/, "");
    const node = value("MC_NODE=");
    const hookJs = value("MC_HOOK_JS=");
    if (node !== undefined && !existsSync(node)) problems.push(`shell: command missing ${node}`);
    if (hookJs !== undefined) problems.push(...launcherProblems("shell", hookJs, lay.hookJs));
  }

  // The uri-handler and autostart files carry the node and mc.js paths in their command text.
  const commandText: Array<[string, string | undefined, RegExp, Layout["mcJs"]]> = [];
  const uri = entry("uri-handler");
  if (uri) {
    if (typeof uri["restoreVbs"] === "string") commandText.push(["uri-handler", uri["restoreVbs"], /Run """(.+?)"" ""(.+?)"" restore/, lay.mcJs]);
    if (typeof uri["desktopFile"] === "string") commandText.push(["uri-handler", uri["desktopFile"], /^Exec="(.+?)" "(.+?)" restore/m, lay.mcJs]);
  }
  const auto = entry("autostart");
  if (auto) {
    if (typeof auto["vbs"] === "string") commandText.push(["autostart", auto["vbs"], /Run """(.+?)"" ""(.+?)"" start/, lay.mcJs]);
    if (typeof auto["unit"] === "string") commandText.push(["autostart", auto["unit"], /^ExecStart="(.+?)" "(.+?)" daemon/m, lay.mcJs]);
    if (typeof auto["desktopFile"] === "string") commandText.push(["autostart", auto["desktopFile"], /^Exec="(.+?)" "(.+?)" start/m, lay.mcJs]);
    if (typeof auto["plist"] === "string") commandText.push(["autostart", auto["plist"], /<string>([^<]+)<\/string>\s*<string>([^<]+)<\/string>\s*<string>daemon<\/string>/, lay.mcJs]);
  }
  for (const [label, file, re, expectedMc] of commandText) {
    if (file === undefined || !existsSync(file)) continue;
    const m = re.exec(readFileSync(file, "utf8"));
    if (!m) continue;
    const [, node, mcJs] = m;
    if (node !== undefined && !existsSync(node)) problems.push(`${label}: command missing ${node}`);
    if (mcJs !== undefined) problems.push(...launcherProblems(label, mcJs, expectedMc));
  }

  return problems.length === 0 ? "ok" : { status: "warn", detail: problems.join("; ") };
}

/** Checks for one OS. `os` is a process.platform value. Checks are data so tests can inject them. */
/**
 * D-50: Windows writes `Enabled = 0` when the user turns an app's notifications off and leaves
 * the value out while they are on (the default), so only an explicit 0 warns.
 */
export function notificationsOutcome(r: { code: number | null; stdout: string }): "ok" | "warn" {
  if (r.code !== 0) return "ok";
  return /Enabled\s+REG_DWORD\s+0x0\b/i.test(r.stdout) ? "warn" : "ok";
}

export function checksFor(platform: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), lay: Layout = layout()): DoctorCheck[] {
  const paths = resolveCliPaths(env, platform as NodeJS.Platform, home);
  const common: DoctorCheck[] = [
    {
      id: "config-valid",
      label: "Config file parses",
      required: true,
      fix: `fix the JSON in ${paths.configFile} (config.md 3)`,
      run: async () => {
        if (!existsSync(paths.configFile)) return "ok";
        try {
          JSON.parse(readFileSync(paths.configFile, "utf8"));
          return { status: "ok", detail: "syntax only; the daemon validates the schema at start" };
        } catch {
          return "missing";
        }
      },
    },
    {
      id: "daemon-reachable",
      label: "Daemon reachable",
      required: false,
      fix: "mc start",
      run: async () => {
        const running = await findRunning(paths);
        return running ? { status: "ok", detail: `pid=${running.pid} port=${running.port}` } : "warn";
      },
    },
    {
      id: "claude-hooks",
      label: "Claude Code hooks installed",
      required: false,
      fix: "mc install claude-code",
      run: async () => {
        const dir = env["CLAUDE_CONFIG_DIR"] || path.join(home, ".claude");
        const settings = path.join(dir, "settings.json");
        if (!existsSync(settings)) return "warn";
        return okIf(readFileSync(settings, "utf8").includes("mc-hook.js"));
      },
    },
    {
      id: "hook-paths",
      label: "Hook paths current",
      required: false,
      fix: "mc install <target>",
      run: async () => hookPathOutcome(paths.stateDir, lay),
    },
  ];

  if (platform === "win32") {
    const aumid = "WoodyDeus.MissionControl";
    return [
      ...common,
      {
        id: "powershell-5.1",
        label: "Windows PowerShell 5.1 present",
        required: true,
        fix: "built in; if missing, notifications and Windows Terminal tab selection are off",
        run: async () => okIf(existsSync(powershellPath(env)), "missing"),
      },
      {
        id: "aumid",
        label: "AUMID registered",
        required: false,
        fix: "mc install uri-handler",
        run: async () => okIf((await probe("reg", ["query", `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`])).code === 0),
      },
      {
        id: "protocol",
        label: "mission-control:// protocol registered",
        required: false,
        fix: "mc install uri-handler",
        run: async () => okIf((await probe("reg", ["query", "HKCU\\Software\\Classes\\mission-control"])).code === 0),
      },
      {
        id: "notifications-enabled",
        label: "App notifications enabled for Mission Control",
        required: false,
        fix: "Settings > System > Notifications",
        run: async () => {
          const r = await probe("reg", ["query", `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`, "/v", "Enabled"]);
          return notificationsOutcome(r);
        },
      },
      {
        id: "koffi",
        label: "koffi loads",
        required: true,
        fix: "npm install",
        run: async () => {
          try {
            koffiRequire()("koffi");
            return "ok";
          } catch {
            return "missing";
          }
        },
      },
      {
        id: "not-elevated",
        label: "Daemon not elevated",
        required: true,
        fix: "run as the normal user; an elevated daemon cannot be reached by non-elevated hooks",
        run: async () => {
          const r = await probe(powershellPath(env), [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
          ]);
          if (r.code !== 0) return "warn";
          return okIf(r.stdout.trim().toLowerCase() !== "true", "missing");
        },
      },
    ];
  }

  if (platform === "darwin") {
    return [
      ...common,
      {
        id: "automation-terminal",
        label: "Automation: Terminal",
        required: false,
        fix: "System Settings > Privacy & Security > Automation > enable Terminal (and iTerm2) under the app that runs the daemon",
        run: async () => {
          if ((await probe("pgrep", ["-x", "Terminal"])).code !== 0) return { status: "ok", detail: "Terminal not running; nothing to check" };
          const r = await probe("osascript", ["-e", 'tell application "Terminal" to count windows']);
          // error -1743 means Automation was denied; any other failure is also a warning.
          return r.code === 0 ? "ok" : "warn";
        },
      },
      {
        id: "accessibility",
        label: "Accessibility",
        required: false,
        fix: "System Settings > Privacy & Security > Accessibility > add the app that runs the daemon (Terminal, or the node binary if launchd started it)",
        run: async () => {
          const r = await probe("osascript", ["-l", "JavaScript", "-e", "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"]);
          return okIf(r.code === 0 && r.stdout.trim() === "true");
        },
      },
      {
        id: "responsible-process",
        label: "TCC responsible process",
        required: false,
        fix: "the app above that owns the daemon's process tree is the one to enable",
        run: async () => {
          const chain: string[] = [];
          let pid = process.ppid;
          for (let i = 0; i < 6 && pid > 1; i++) {
            const r = await probe("ps", ["-o", "comm=", "-o", "ppid=", "-p", String(pid)]);
            const [comm, ppid] = r.stdout.trim().split(/\s+/);
            if (!comm || !ppid) break;
            chain.push(comm);
            pid = Number(ppid);
          }
          return { status: "ok", detail: chain.length > 0 ? chain.join(" <- ") : "unknown" };
        },
      },
    ];
  }

  // linux: the selected backend decides which tools are needed (linux.md 1 and 7).
  const configured = (() => {
    try {
      const cfg = JSON.parse(readFileSync(paths.configFile, "utf8")) as { linux?: { waylandBackend?: string } };
      return cfg.linux?.waylandBackend;
    } catch {
      return undefined;
    }
  })();
  let backend: string;
  if (configured && configured !== "auto") backend = configured;
  else if (env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) backend = "x11";
  else if (env["SWAYSOCK"]) backend = "sway";
  else if (env["HYPRLAND_INSTANCE_SIGNATURE"]) backend = "hyprland";
  else if (/KDE/i.test(env["XDG_CURRENT_DESKTOP"] ?? "")) backend = "kwin";
  else if (/GNOME/i.test(env["XDG_CURRENT_DESKTOP"] ?? "")) backend = "gnome-extension";
  else backend = "none";

  const toolCheck = (id: string, required: boolean, fix: string): DoctorCheck => ({
    id,
    label: `${id} installed`,
    required,
    fix,
    run: async () => okIf(await hasCommand(id), required ? "missing" : "warn"),
  });
  const dbusName = (id: string, name: string, fix: string): DoctorCheck => ({
    id,
    label: `D-Bus name ${name}`,
    required: true,
    fix,
    run: async () => {
      if (!(await hasCommand("gdbus"))) return "warn";
      const r = await probe("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", name]);
      return okIf(r.code === 0 && r.stdout.includes("true"), "missing");
    },
  });

  const backendChecks: DoctorCheck[] = (() => {
    switch (backend) {
      case "x11":
        return [
          toolCheck("wmctrl", true, "sudo apt install wmctrl x11-utils (Debian/Ubuntu), sudo dnf install wmctrl xprop"),
          toolCheck("xprop", true, "sudo apt install x11-utils (Debian/Ubuntu), sudo dnf install xprop"),
          toolCheck("xdotool", false, "optional X11 fallback"),
        ];
      case "sway":
        return [toolCheck("swaymsg", true, "ships with sway")];
      case "hyprland":
        return [toolCheck("hyprctl", true, "ships with Hyprland")];
      case "kwin":
        return [dbusName("kwin-dbus", "org.kde.KWin", "ships with Plasma")];
      case "gnome-extension":
        return [dbusName("gnome-shell-dbus", "org.gnome.Shell", "install the Window Calls extension: extensions.gnome.org/extension/4724")];
      default:
        return [
          {
            id: "focus-backend",
            label: "Focus backend (Wayland, no compositor IPC)",
            required: false,
            fix: "restore copies the cwd and shows FOCUS MANUALLY (linux.md 1)",
            run: async () => "warn",
          },
        ];
    }
  })();

  return [
    ...common,
    ...backendChecks,
    {
      id: "notification-server",
      label: "Notification server on D-Bus",
      required: false,
      fix: "on bare WMs install dunst or mako",
      run: async () => {
        if (!(await hasCommand("gdbus"))) return "warn";
        const r = await probe("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.Notifications"]);
        return okIf(r.code === 0 && r.stdout.includes("true"));
      },
    },
    {
      id: "tmux",
      label: "tmux 3.0 or newer",
      required: false,
      fix: "install tmux 3.0+ for tmux sessions",
      run: async () => {
        const r = await probe("tmux", ["-V"]);
        const m = /(\d+)\.(\d+)/.exec(r.stdout);
        if (r.code !== 0 || !m) return "warn";
        return okIf(Number(m[1]) >= 3);
      },
    },
  ];
}
