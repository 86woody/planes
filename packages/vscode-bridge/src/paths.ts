// config.md section 1 and 2, third copy (daemon and hook hold the others). Kept small on
// purpose; tested against packages/daemon/test/fixtures/paths.json (VB-08).
import os from "node:os";
import path from "node:path";

export interface McPaths {
  configDir: string;
  stateDir: string;
  configFile: string;
  tokenFile: string;
  daemonFile: string;
  sessionsFile: string;
  eventsFile: string;
  spoolDir: string;
  hookErrorsFile: string;
  logFile: string;
  fakePlatformFile: string;
  installManifestFile: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

const APP = "mission-control";

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function resolvePaths(env: EnvLike, platform: string, home: string): McPaths {
  const p = platform === "win32" ? path.win32 : path.posix;
  const mcHome = nonEmpty(env.MC_HOME);
  let configDir: string;
  let stateDir: string;
  if (mcHome !== undefined) {
    configDir = p.join(mcHome, "config");
    stateDir = p.join(mcHome, "state");
  } else if (platform === "win32") {
    configDir = p.join(nonEmpty(env.APPDATA) ?? p.join(home, "AppData", "Roaming"), APP);
    stateDir = p.join(nonEmpty(env.LOCALAPPDATA) ?? p.join(home, "AppData", "Local"), APP);
  } else if (platform === "darwin") {
    configDir = p.join(home, "Library", "Application Support", APP);
    stateDir = p.join(configDir, "state");
  } else {
    configDir = p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(home, ".config"), APP);
    stateDir = p.join(nonEmpty(env.XDG_STATE_HOME) ?? p.join(home, ".local", "state"), APP);
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

/** The paths of the machine this extension host runs on. */
export function hostPaths(): McPaths {
  return resolvePaths(process.env, process.platform, os.homedir());
}
