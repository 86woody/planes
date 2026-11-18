import os from "node:os";
import path from "node:path";
import { layout } from "@mc/platform/layout";

/** The install root: the clone in clone mode, the package directory in package mode; the name stays for existing imports. */
export const REPO_ROOT = layout().root;

export interface CliPaths {
  configDir: string;
  stateDir: string;
  configFile: string;
  tokenFile: string;
  daemonFile: string;
  browserSessionsFile: string;
  logFile: string;
}

/** config.md section 1 and 2. The daemon owns the same rules; this copy keeps the CLI free of daemon code. */
export function resolveCliPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): CliPaths {
  let configDir: string;
  let stateDir: string;
  if (env["MC_HOME"]) {
    configDir = path.join(env["MC_HOME"], "config");
    stateDir = path.join(env["MC_HOME"], "state");
  } else if (platform === "win32") {
    configDir = path.join(env["APPDATA"] || path.join(home, "AppData", "Roaming"), "mission-control");
    stateDir = path.join(env["LOCALAPPDATA"] || path.join(home, "AppData", "Local"), "mission-control");
  } else if (platform === "darwin") {
    configDir = path.join(home, "Library", "Application Support", "mission-control");
    stateDir = path.join(configDir, "state");
  } else {
    configDir = path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "mission-control");
    stateDir = path.join(env["XDG_STATE_HOME"] || path.join(home, ".local", "state"), "mission-control");
  }
  return {
    configDir,
    stateDir,
    configFile: path.join(configDir, "config.json"),
    tokenFile: path.join(stateDir, "token"),
    daemonFile: path.join(stateDir, "daemon.json"),
    browserSessionsFile: path.join(stateDir, "browser-sessions.json"),
    logFile: path.join(stateDir, "daemon.log"),
  };
}

/** The built daemon entry; the same file `mc start` spawns and `mc daemon` runs in the foreground. */
export const DAEMON_BIN = layout().daemonJs;
