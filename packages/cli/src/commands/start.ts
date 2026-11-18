import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Layout, layout } from "@mc/platform/layout";
import type { Io } from "../main.js";
import { type CliPaths, resolveCliPaths } from "../lib/paths.js";
import { ensureRunning } from "../lib/control.js";
import { writeLaunchers } from "../installers/launcher.js";

/** D-41.3: rewrite the launchers when their target moved. Writes nothing when no install is recorded. */
export function healLaunchers(paths: CliPaths, io: { out(s: string): void }, lay: Layout = layout()): boolean {
  const file = path.join(paths.stateDir, "install-manifest.json");
  if (!existsSync(file)) return false;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return false;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest) || Object.keys(manifest).length === 0) return false;
  const { changed } = writeLaunchers(paths.stateDir, lay);
  if (changed) io.out(`launchers updated -> ${lay.root}`);
  return changed;
}

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length > 0) {
    io.err("usage: mc start");
    return 2;
  }
  const paths = resolveCliPaths(io.env);
  healLaunchers(paths, io);
  const result = await ensureRunning(paths, io);
  if (!result) return 1;
  if (!result.started) io.out(`already running pid=${result.running.pid} port=${result.running.port}`);
  return 0;
}
