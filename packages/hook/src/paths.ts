// config.md section 1: the hook's copy of the daemon's path rules (duplicated on purpose,
// so the hook loads no daemon code). Tested against packages/daemon/test/fixtures/paths.json.
import os from "node:os";
import path from "node:path";

export interface Paths {
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

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === "" ? undefined : v;
}

export function resolvePaths(env: Env, platform: string, home: string): Paths {
  const p = platform === "win32" ? path.win32 : path.posix;
  const mcHome = nonEmpty(env.MC_HOME);
  let configDir: string;
  let stateDir: string;
  if (mcHome !== undefined) {
    configDir = p.join(mcHome, "config");
    stateDir = p.join(mcHome, "state");
  } else if (platform === "win32") {
    configDir = p.join(nonEmpty(env.APPDATA) ?? p.join(home, "AppData", "Roaming"), "mission-control");
    stateDir = p.join(nonEmpty(env.LOCALAPPDATA) ?? p.join(home, "AppData", "Local"), "mission-control");
  } else if (platform === "darwin") {
    configDir = p.join(home, "Library", "Application Support", "mission-control");
    stateDir = p.join(configDir, "state");
  } else {
    configDir = p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(home, ".config"), "mission-control");
    stateDir = p.join(nonEmpty(env.XDG_STATE_HOME) ?? p.join(home, ".local", "state"), "mission-control");
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

export function defaultPaths(): Paths {
  return resolvePaths(process.env, process.platform, os.homedir());
}
