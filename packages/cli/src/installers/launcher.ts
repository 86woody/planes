import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Layout } from "@mc/platform/layout";
import { writeAtomic } from "./json-edit.js";

export interface LauncherPaths {
  readonly dir: string;
  readonly hookJs: string;
  readonly mcJs: string;
}

/** PACKAGING.md 4: the launchers live in <stateDir>/bin, next to the package.json that makes them CommonJS. */
export function launcherPaths(stateDir: string): LauncherPaths {
  const dir = path.join(stateDir, "bin");
  return { dir, hookJs: path.join(dir, "mc-hook.js"), mcJs: path.join(dir, "mc.js") };
}

export function launcherText(kind: "hook" | "mc", target: string, version: string): string {
  const exit = kind === "hook" ? 0 : 1;
  return (
    `// mission-control launcher. target: ${target}. version: ${version}\n` +
    `import(${JSON.stringify(pathToFileURL(target).href)}).catch((e) => { process.stderr.write(String(e && e.stack || e) + "\\n"); process.exit(${exit}); });\n`
  );
}

const HEADER = /^\/\/ mission-control launcher\. target: (.*)\. version: (.*)$/;

/** The target a launcher imports, or null when the file is missing or is not a launcher. */
export function readLauncherTarget(file: string): string | null {
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
  const m = HEADER.exec(first.replace(/\r$/, ""));
  return m ? (m[1] ?? null) : null;
}

/** Writes or repairs both launchers. A file whose text already matches is not rewritten. */
export function writeLaunchers(stateDir: string, lay: Layout): { changed: boolean } {
  const bin = launcherPaths(stateDir);
  const changed = readLauncherTarget(bin.hookJs) !== lay.hookJs || readLauncherTarget(bin.mcJs) !== lay.mcJs;
  writeIfDifferent(path.join(bin.dir, "package.json"), '{"type":"commonjs"}\n');
  writeIfDifferent(bin.hookJs, launcherText("hook", lay.hookJs, lay.version));
  writeIfDifferent(bin.mcJs, launcherText("mc", lay.mcJs, lay.version));
  return { changed };
}

function writeIfDifferent(file: string, text: string): void {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeAtomic(file, text);
}
