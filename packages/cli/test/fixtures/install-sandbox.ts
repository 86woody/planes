import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Exec, ExecResult } from "@mc/platform";
import { type Layout, layoutFor } from "@mc/platform/layout";
import type { Io } from "../../src/main.js";
import type { CtxInput } from "../../src/installers/manifest.js";

/** The clone root, four levels up from this file (packages/cli/test/fixtures). */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const NODE = "C:\\Program Files\\nodejs\\node.exe";
/** The clone layout of this checkout (PACKAGING.md 3). */
export const LAYOUT: Layout = layoutFor("clone", REPO, "0.0.0-test");

export interface Sandbox {
  home: string;
  mcHome: string;
  claudeDir: string;
  stateDir: string;
  configDir: string;
  /** Every command the installers asked to run, as [file, ...args]. Nothing is executed. */
  calls: string[][];
  out: string[];
  errs: string[];
  io: Io;
  input: Partial<CtxInput>;
  cleanup(): void;
}

export interface SandboxOpts {
  platform?: NodeJS.Platform;
  onPath?: string[];
  hasSystemd?: boolean;
  uid?: number;
  reply?: (file: string, args: string[]) => Partial<ExecResult> | undefined;
  /** No MC_HOME: env is CLAUDE_CONFIG_DIR only, and the dirs follow the Linux rules of config.md 1 under the temp HOME. */
  noMcHome?: boolean;
}

/** The hook launcher path as an installer writes it (forward slashes). */
export function launcherHook(sb: { stateDir: string }): string {
  return path.join(sb.stateDir, "bin", "mc-hook.js").replace(/\\/g, "/");
}

/** The mc launcher path as an installer writes it (forward slashes). */
export function launcherMc(sb: { stateDir: string }): string {
  return path.join(sb.stateDir, "bin", "mc.js").replace(/\\/g, "/");
}

/** Temp HOME, MC_HOME, CLAUDE_CONFIG_DIR and a recording runner. Never reads or writes the real machine. */
export function sandbox(opts: SandboxOpts = {}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "mc-t051-"));
  const home = path.join(root, "home");
  const mcHome = path.join(root, "mc");
  const claudeDir = path.join(root, "claude");
  mkdirSync(home, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  const calls: string[][] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const run: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const r = opts.reply?.(file, args);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...r };
  };
  const env: NodeJS.ProcessEnv = opts.noMcHome
    ? { CLAUDE_CONFIG_DIR: claudeDir }
    : { MC_HOME: mcHome, CLAUDE_CONFIG_DIR: claudeDir };
  const io: Io = { out: (s) => out.push(s), err: (s) => errs.push(s), env, cwd: root };
  const input: Partial<CtxInput> = {
    env,
    platform: opts.platform ?? "linux",
    home,
    nodePath: NODE,
    repo: REPO,
    now: new Date(2026, 10, 12, 9, 30, 5),
    run,
    onPath: async (cmd: string) => (opts.onPath ?? []).includes(cmd),
    hasSystemd: () => opts.hasSystemd ?? false,
    uid: () => opts.uid ?? 501,
    layout: LAYOUT,
  };
  return {
    home,
    mcHome,
    claudeDir,
    stateDir: opts.noMcHome ? path.join(home, ".local", "state", "mission-control") : path.join(mcHome, "state"),
    configDir: opts.noMcHome ? path.join(home, ".config", "mission-control") : path.join(mcHome, "config"),
    calls,
    out,
    errs,
    io,
    input,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
