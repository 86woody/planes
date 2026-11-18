import path from "node:path";
import type { Paths } from "./internal.js";

// config.md sections 1-2. Pure: no fs calls. win32 uses path.win32, everything else path.posix.
export function resolvePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Paths {
  const p = platform === "win32" ? path.win32 : path.posix;
  let configDir: string;
  let stateDir: string;

  if (env.MC_HOME) {
    configDir = p.join(env.MC_HOME, "config");
    stateDir = p.join(env.MC_HOME, "state");
  } else if (platform === "win32") {
    configDir = p.join(env.APPDATA || p.join(home, "AppData", "Roaming"), "mission-control");
    stateDir = p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "mission-control");
  } else if (platform === "darwin") {
    configDir = p.join(home, "Library", "Application Support", "mission-control");
    stateDir = p.join(configDir, "state");
  } else {
    configDir = p.join(env.XDG_CONFIG_HOME || p.join(home, ".config"), "mission-control");
    stateDir = p.join(env.XDG_STATE_HOME || p.join(home, ".local", "state"), "mission-control");
  }

  return {
    configDir,
    stateDir,
    configFile: p.join(configDir, "config.json"),
    tokenFile: p.join(stateDir, "token"),
    daemonFile: p.join(stateDir, "daemon.json"),
    sessionsFile: p.join(stateDir, "sessions.json"),
    eventsFile: p.join(stateDir, "events.jsonl"),
    spoolDir: p.join(stateDir, "spool"),
    hookErrorsFile: p.join(stateDir, "hook-errors.log"),
    logFile: p.join(stateDir, "daemon.log"),
    fakePlatformFile: p.join(stateDir, "fake-platform.jsonl"),
    installManifestFile: p.join(stateDir, "install-manifest.json"),
  };
}
