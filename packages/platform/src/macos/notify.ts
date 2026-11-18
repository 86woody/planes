import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Capabilities, OsNotification } from "@mc/contracts";
import type { Exec } from "../exec.js";
import { layout } from "../layout.js";
import type { NotifyHandle, PlatformEnv } from "../types.js";

type Issues = Capabilities["issues"];
type Backend = "alerter" | "terminal-notifier" | "osascript";

const MAX_LIVE_ALERTERS = 10;
const OSASCRIPT_BIN = "/usr/bin/osascript";
const HELPER_TIMEOUT_MS = 1500;

/** Single-quote a string for POSIX sh, escaping embedded `'` as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Synchronous `which`, used at creation (createNotify is synchronous). */
function whichSync(cmd: string): string | null {
  const r =
    process.platform === "win32"
      ? spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true })
      : spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", cmd], { encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim() !== "");
  return first === undefined ? null : first.trim();
}

export function alerterArgs(n: OsNotification): string[] {
  return [
    "-title", n.title,
    "-message", n.body,
    "-group", n.tag,
    "-actions", "RESTORE",
    "-timeout", "600",
    "-json",
  ];
}

/**
 * Click runs `mc restore` through the absolute node binary and mc.js. Without a
 * session id there is nothing to restore, so no -execute is given (no click action).
 */
export function terminalNotifierArgs(
  n: OsNotification,
  paths: { node: string; mcJs: string },
): string[] {
  const args = ["-title", n.title, "-message", n.body, "-group", n.tag, "-sound", "default"];
  if (n.sessionId !== null) {
    const cmd = [
      shellQuote(paths.node),
      shellQuote(paths.mcJs),
      "restore",
      shellQuote(`mission-control://restore/${n.sessionId}`),
      "--from-notification",
    ].join(" ");
    args.push("-execute", cmd);
  }
  return args;
}

/** Arguments for `/usr/bin/osascript`: the script file, then title and body as argv. */
export function osascriptArgs(n: OsNotification): string[] {
  return [join(layout().macosScriptsDir, "notify-osascript.applescript"), n.title, n.body];
}

interface Live {
  backend: "alerter";
  child: ChildProcess;
  tag: string;
}

export function createNotify(deps: { exec: Exec; env: PlatformEnv }): {
  notify(
    n: OsNotification,
    onClick: (sessionId: string | null) => void,
  ): Promise<NotifyHandle | null>;
  withdraw(h: NotifyHandle): Promise<void>;
  probe(): Promise<{ notify: boolean; notifyClick: boolean; issues: Issues }>;
  dispose(): Promise<void>;
  backend: Backend;
} {
  const backend: Backend = whichSync("alerter")
    ? "alerter"
    : whichSync("terminal-notifier")
      ? "terminal-notifier"
      : "osascript";
  const terminalNotifierPath = backend === "terminal-notifier" ? whichSync("terminal-notifier") : null;
  const mcJs = layout().mcJs;

  // Live alerter processes, oldest first (Map keeps insertion order).
  const live = new Map<string, Live>();
  // Tags of every notification shown, so withdraw can remove by tag.
  const shown = new Map<string, { tag: string }>();
  let seq = 0;

  function killLive(id: string): void {
    const entry = live.get(id);
    if (entry === undefined) return;
    live.delete(id);
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  function notifyAlerter(
    n: OsNotification,
    onClick: (sessionId: string | null) => void,
  ): NotifyHandle | null {
    const id = `alerter:${++seq}`;
    const child = spawn("alerter", alerterArgs(n), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.on("error", () => {
      live.delete(id);
    });
    child.on("close", () => {
      live.delete(id);
      let activation: unknown;
      try {
        activation = (JSON.parse(stdout.trim()) as { activationType?: unknown }).activationType;
      } catch {
        return; // no JSON: timeout or closed, nothing to do
      }
      if (activation === "contentsClicked" || activation === "actionClicked") {
        onClick(n.sessionId);
      }
    });
    live.set(id, { backend: "alerter", child, tag: n.tag });
    shown.set(id, { tag: n.tag });
    while (live.size > MAX_LIVE_ALERTERS) {
      const oldest = live.keys().next().value;
      if (oldest === undefined) break;
      killLive(oldest);
    }
    return { id };
  }

  async function notifyHelper(n: OsNotification): Promise<NotifyHandle | null> {
    let bin: string;
    let args: string[];
    if (backend === "terminal-notifier") {
      if (terminalNotifierPath === null) return null;
      bin = terminalNotifierPath;
      args = terminalNotifierArgs(n, { node: process.execPath, mcJs });
    } else {
      bin = OSASCRIPT_BIN;
      args = osascriptArgs(n);
    }
    const r = await deps.exec(bin, args, { timeoutMs: HELPER_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const id = `${backend}:${++seq}`;
    shown.set(id, { tag: n.tag });
    return { id };
  }

  return {
    backend,

    async notify(n, onClick) {
      try {
        if (backend === "alerter") return notifyAlerter(n, onClick);
        return await notifyHelper(n);
      } catch {
        return null;
      }
    },

    async withdraw(h) {
      try {
        const entry = shown.get(h.id);
        shown.delete(h.id);
        if (entry === undefined) return;
        if (h.id.startsWith("alerter:")) {
          killLive(h.id);
          await deps.exec("alerter", ["-remove", entry.tag], { timeoutMs: HELPER_TIMEOUT_MS });
        } else if (h.id.startsWith("terminal-notifier:") && terminalNotifierPath !== null) {
          await deps.exec(terminalNotifierPath, ["-remove", entry.tag], { timeoutMs: HELPER_TIMEOUT_MS });
        }
        // osascript: no-op
      } catch {
        // best effort
      }
    },

    async probe() {
      const issues: Issues = [];
      if (backend === "osascript") {
        issues.push({
          code: "macos_notify_no_click",
          severity: "info",
          message: "Notifications have no click action: clicking opens Script Editor.",
          fix: "brew install vjeantet/tap/alerter",
        });
      }
      return { notify: true, notifyClick: backend !== "osascript", issues };
    },

    async dispose() {
      for (const id of [...live.keys()]) killLive(id);
      shown.clear();
    },
  };
}
