import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, type Exec, which } from "@mc/platform";
import { type Layout, layout } from "@mc/platform/layout";
import type { Io } from "../main.js";
import { ConfigParseError, readJsonFile, type WriteState, writeAtomic, jsonText } from "./json-edit.js";
import { launcherPaths, writeLaunchers } from "./launcher.js";

export interface Dirs {
  configDir: string;
  stateDir: string;
}

/** config.md section 1, the same rules the daemon uses (duplicated on purpose, as the contract allows). */
export function dirsFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Dirs {
  if (env.MC_HOME) {
    return { configDir: path.join(env.MC_HOME, "config"), stateDir: path.join(env.MC_HOME, "state") };
  }
  if (platform === "win32") {
    return {
      configDir: path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "mission-control"),
      stateDir: path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "mission-control"),
    };
  }
  if (platform === "darwin") {
    const configDir = path.join(home, "Library", "Application Support", "mission-control");
    return { configDir, stateDir: path.join(configDir, "state") };
  }
  return {
    configDir: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "mission-control"),
    stateDir: path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "mission-control"),
  };
}

/** Everything an installer may touch from outside. Tests inject all of it; nothing defaults to the real machine. */
export interface CtxInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** process.execPath of the mc process doing the install. */
  nodePath: string;
  /** Clone root (vscode.ts reads its workspace package.json from it). */
  repo: string;
  /** the install layout, injected by tests */
  layout?: Layout;
  now: Date;
  dryRun: boolean;
  run: Exec;
  onPath: (cmd: string) => Promise<boolean>;
  hasSystemd: () => boolean;
  uid: () => number | null;
}

export interface Ctx extends CtxInput, Dirs, WriteState {
  /** The install layout; every shipped asset path comes from here (T081). */
  layout: Layout;
  out(s: string): void;
  err(s: string): void;
}

/** reg.exe, launchctl and the like are .exe or invoked directly; .cmd shims (npm, code) need cmd.exe on Windows. */
export const realRun: Exec = (file, args, opts) => {
  if (process.platform === "win32" && !/\.exe$/i.test(file)) {
    const line = [file, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    // Verbatim: without it Node escapes the outer quotes as \" and cmd.exe cannot parse the line (T101).
    return exec("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return exec(file, args, opts);
};

export function makeCtx(io: Io, input: Partial<CtxInput> = {}): Ctx {
  const env = input.env ?? io.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const dirs = dirsFor(env, platform, home);
  const lay = input.layout ?? layout();
  return {
    layout: lay,
    env,
    platform,
    home,
    nodePath: input.nodePath ?? process.execPath,
    repo: input.repo ?? lay.root,
    now: input.now ?? new Date(),
    dryRun: input.dryRun ?? false,
    run: input.run ?? realRun,
    onPath: input.onPath ?? (async (cmd: string) => (await which(cmd)) !== null),
    hasSystemd: input.hasSystemd ?? (() => existsSync("/run/systemd/system")),
    uid: input.uid ?? (() => (typeof process.getuid === "function" ? process.getuid() : null)),
    configDir: dirs.configDir,
    stateDir: dirs.stateDir,
    backedUp: new Set<string>(),
    out: (s: string) => io.out(s),
    err: (s: string) => io.err(s),
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Forward slashes: claude-hooks.md 1 and ingest.md 6.1 write paths this way, also on Windows. */
export function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The stable launcher in stateDir/bin (D-41), never the clone path. */
export function hookJsPath(ctx: Ctx): string {
  return launcherPaths(ctx.stateDir).hookJs;
}

export function mcJsPath(ctx: Ctx): string {
  return launcherPaths(ctx.stateDir).mcJs;
}

/** Writes the launchers unless this is a dry run. Installers call it before they record or write a launcher path. */
export function prepareLaunchers(ctx: Ctx): { changed: boolean } {
  if (ctx.dryRun) return { changed: false };
  return writeLaunchers(ctx.stateDir, ctx.layout);
}

/** install-manifest.json: one entry per target, holding exactly what that installer wrote. */
export type Manifest = Record<string, Record<string, unknown>>;

export function manifestPath(ctx: Ctx): string {
  return path.join(ctx.stateDir, "install-manifest.json");
}

export function readManifest(ctx: Ctx): Manifest {
  const r = readJsonFile(manifestPath(ctx));
  if (!r.exists) return {};
  if (!isObject(r.value)) throw new ConfigParseError(`${manifestPath(ctx)} is not a JSON object`);
  return r.value as Manifest;
}

export function saveManifest(ctx: Ctx, m: Manifest): void {
  writeAtomic(manifestPath(ctx), jsonText(m));
}
