import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type Ctx, isObject, readManifest, saveManifest } from "./manifest.js";

const LONG = { timeoutMs: 600000 };
const BRIDGE = "vscode-bridge";
const EXTENSION_ID = "woody.vscode-bridge";
const EDITORS = ["code", "code-insiders", "cursor"];

/** D-30: the extension id is publisher.name of the bridge package, with the scope dropped. A package install has no workspace package.json, so it is fixed. */
export function bridgeExtensionId(ctx: Ctx): string {
  if (ctx.layout.mode === "package") return EXTENSION_ID;
  const pkg = JSON.parse(readFileSync(path.join(ctx.repo, "packages", "vscode-bridge", "package.json"), "utf8")) as {
    name: string;
    publisher: string;
  };
  return `${pkg.publisher}.${pkg.name.replace(/^@[^/]+\//, "")}`;
}

/** Installs one .vsix into every editor CLI on PATH. Each success is recorded at once so uninstall can reach it. */
async function installInto(ctx: Ctx, vsix: string): Promise<{ installed: string[]; failed: boolean }> {
  const installed: string[] = [];
  let failed = false;
  for (const editor of EDITORS) {
    if (!(await ctx.onPath(editor))) continue;
    const r = await ctx.run(editor, ["--install-extension", vsix], LONG);
    if (r.code !== 0) {
      ctx.err(`vscode: ${editor} --install-extension failed: ${r.stderr.trim() || r.stdout.trim()}\n`);
      failed = true;
      continue;
    }
    installed.push(editor);
    const current = readManifest(ctx);
    const entry = isObject(current.vscode) ? current.vscode : {};
    current.vscode = { ...entry, installedWith: [...installed] };
    saveManifest(ctx, current);
  }
  return { installed, failed };
}

/** Package mode: install the .vsix shipped in the npm package. No npm, no vsce, no build (D-43). */
async function installShipped(ctx: Ctx, vsix: string): Promise<number> {
  if (!existsSync(vsix)) {
    ctx.err(`vscode: packaged extension missing: ${vsix}\n`);
    return 1;
  }
  const manifest = readManifest(ctx);
  manifest.vscode = { vsix, installedWith: [] as string[], extensionId: EXTENSION_ID, shipped: true };
  saveManifest(ctx, manifest);
  const { installed, failed } = await installInto(ctx, vsix);
  if (failed) return 1;
  ctx.out(
    installed.length > 0
      ? `vscode: installed into ${installed.join(", ")}\n`
      : `vscode: no editor CLI on PATH; ${vsix} is the extension file\n`,
  );
  return 0;
}

/** mc install vscode: build, package, install into every editor CLI on PATH (installer step 6). */
export async function installVscode(ctx: Ctx): Promise<number> {
  const shipped = ctx.layout.vsixPath;
  if (shipped !== null) return installShipped(ctx, shipped);
  const filter = ["--prefix", ctx.repo, "-w", BRIDGE];
  const build = await ctx.run("npm", [...filter, "run", "build"], LONG);
  if (build.code !== 0) {
    ctx.err(`vscode: bridge build failed: ${build.stderr.trim() || build.stdout.trim()}\n`);
    return 1;
  }
  const vsix = path.join(ctx.stateDir, "mission-control-bridge.vsix");
  const manifest = readManifest(ctx);
  manifest.vscode = { vsix, installedWith: [] as string[], extensionId: bridgeExtensionId(ctx) };
  saveManifest(ctx, manifest);
  const pack = await ctx.run("npm", [...filter, "exec", "--", "vsce", "package", "--no-dependencies", "-o", vsix], LONG);
  if (pack.code !== 0) {
    ctx.err(`vscode: vsce package failed: ${pack.stderr.trim() || pack.stdout.trim()}\n`);
    return 1;
  }
  const { installed, failed } = await installInto(ctx, vsix);
  if (failed) return 1;
  ctx.out(installed.length > 0 ? `vscode: installed into ${installed.join(", ")}\n` : `vscode: no editor CLI on PATH; ${vsix} written\n`);
  return 0;
}

/** mc uninstall vscode: removes the recorded extension from each editor it went into, and the vsix unless it ships in the package. */
export async function uninstallVscode(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest.vscode;
  if (!isObject(entry)) {
    ctx.out("vscode: not installed by mc\n");
    return 0;
  }
  const editors = Array.isArray(entry.installedWith) ? entry.installedWith.map(String) : [];
  // D-59 (T124 review): an editor that fails keeps its manifest entry, so a retry still reaches it.
  // "is not installed" means it is already gone, which counts as removed.
  const failed: string[] = [];
  for (const editor of editors) {
    const r = await ctx.run(editor, ["--uninstall-extension", String(entry.extensionId)], LONG);
    const gone = /is not installed/i.test(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0 && !gone) {
      ctx.err(`vscode: ${editor} --uninstall-extension failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}\n`);
      failed.push(editor);
    }
  }
  if (failed.length > 0) {
    entry.installedWith = failed;
    saveManifest(ctx, manifest);
    return 1;
  }
  if (typeof entry.vsix === "string" && entry.shipped !== true) rmSync(entry.vsix, { force: true });
  delete manifest.vscode;
  saveManifest(ctx, manifest);
  ctx.out("vscode: removed\n");
  return 0;
}
