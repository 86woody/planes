import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Io } from "../main.js";
import { type Ctx, type CtxInput, makeCtx, readManifest } from "../installers/manifest.js";
import { uninstallClaude } from "../installers/claude.js";
import { uninstallCopilot } from "../installers/copilot.js";
import { uninstallCodex } from "../installers/codex.js";
import { uninstallShell } from "../installers/shell.js";
import { uninstallUri } from "../installers/uri.js";
import { uninstallAutostart } from "../installers/autostart.js";
import { uninstallVscode } from "../installers/vscode.js";
import { stopDaemon } from "../lib/control.js";
import { resolveCliPaths } from "../lib/paths.js";

type Handler = (ctx: Ctx) => Promise<number>;

const HANDLER_OF: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ["claude-code", uninstallClaude],
  ["codex", uninstallCodex],
  ["copilot", uninstallCopilot],
  ["shell", uninstallShell],
  ["uri-handler", uninstallUri],
  ["autostart", uninstallAutostart],
  ["vscode", uninstallVscode],
]);

/** D-59 step 2: the fixed run order of `--all`. */
const ALL_ORDER = ["vscode", "autostart", "uri-handler", "shell", "codex", "copilot", "claude-code"];
/** Run even without a manifest entry: their uninstall finds our entries in the files and changes nothing when there are none. */
const ALWAYS = new Set(["claude-code", "copilot", "codex", "shell"]);

const USAGE = `usage: mc uninstall <${[...HANDLER_OF.keys()].join("|")}> | --all [--purge]\n`;

export async function run(argv: string[], io: Io, input: Partial<CtxInput> = {}): Promise<number> {
  const ctx = makeCtx(io, input);
  if (argv.includes("--all") || argv.includes("--purge")) {
    const valid =
      argv.includes("--all") &&
      argv.every((a) => a === "--all" || a === "--purge") &&
      new Set(argv).size === argv.length;
    if (!valid) {
      io.err(USAGE);
      return 2;
    }
    return runAll(ctx, io, argv.includes("--purge"));
  }

  const target = argv[0];
  const handler = target !== undefined && argv.length === 1 ? HANDLER_OF.get(target) : undefined;
  if (target === undefined || handler === undefined) {
    io.err(USAGE);
    return 2;
  }
  try {
    return await handler(ctx);
  } catch (err) {
    io.err(`mc uninstall ${target}: ${(err as Error).message}\n`);
    return 1;
  }
}

/** D-59: `mc uninstall --all [--purge]`. Stops the daemon, runs every target, then optionally purges the two dirs. */
async function runAll(ctx: Ctx, io: Io, purge: boolean): Promise<number> {
  // The daemon of the same dirs this run removes (ctx's env, platform and home), never the machine default.
  const stopped = await stopDaemon(resolveCliPaths(ctx.env, ctx.platform, ctx.home), io);
  if (stopped === "failed") {
    ctx.err("daemon: could not stop\n");
    return 1;
  }
  ctx.out(stopped === "stopped" ? "daemon: stopped\n" : "daemon: not running\n");

  let failed = false;
  let names: string[];
  try {
    const manifest = readManifest(ctx);
    names = ALL_ORDER.filter((t) => ALWAYS.has(t) || manifest[t] !== undefined);
  } catch (err) {
    ctx.err(`manifest: ${(err as Error).message}\n`);
    failed = true;
    names = ALL_ORDER.filter((t) => ALWAYS.has(t));
  }

  for (const name of names) {
    const handler = HANDLER_OF.get(name);
    if (handler === undefined) continue;
    let code: number;
    try {
      code = await handler(ctx);
    } catch (err) {
      ctx.err(`${name}: failed: ${(err as Error).message}\n`);
      failed = true;
      continue;
    }
    if (code !== 0) {
      ctx.err(`${name}: failed: exit ${code}\n`);
      failed = true;
      continue;
    }
    ctx.out(`${name}: removed\n`);
  }

  const dirs = [ctx.configDir, ctx.stateDir];
  if (!purge) {
    for (const dir of dirs) if (existsSync(dir)) ctx.out(`left in place: ${dir}\n`);
    ctx.out("mc uninstall --all --purge also deletes them\n");
  } else if (failed) {
    ctx.err("purge skipped: fix the failures above and run again\n");
  } else {
    const refused = dirs.filter((dir) => !purgeAllowed(dir, ctx.env));
    if (refused.length > 0) {
      for (const dir of refused) ctx.err(`purge: refusing to delete ${dir}\n`);
      return 1;
    }
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
      ctx.out(`deleted ${dir}\n`);
    }
  }

  if (failed) return 1;
  ctx.out("mission-control removed. Now run: npm rm -g mission-control-desktop\n");
  return 0;
}

/**
 * The purge guard (D-59): a directory named mission-control, or `state` directly inside one (the
 * macOS state dir, config.md 1), or exactly MC_HOME/state or MC_HOME/config.
 */
function purgeAllowed(dir: string, env: NodeJS.ProcessEnv): boolean {
  if (path.basename(dir) === "mission-control") return true;
  if (path.basename(dir) === "state" && path.basename(path.dirname(dir)) === "mission-control") return true;
  const home = env.MC_HOME;
  return home !== undefined && home !== "" && (dir === path.join(home, "state") || dir === path.join(home, "config"));
}
