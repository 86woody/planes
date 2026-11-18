import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readJsonFile, jsonText, writeAtomic, writeWithBackup } from "./json-edit.js";
import { type Ctx, fwd, hookJsPath, isObject, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

export type ShellKind = "pwsh" | "bash" | "zsh";

export const SHELL_BEGIN = "# >>> mission-control >>>";
export const SHELL_END = "# <<< mission-control <<<";
const EXT: Record<ShellKind, string> = { pwsh: "ps1", bash: "bash", zsh: "zsh" };
const PLACEHOLDER = "__MC_STATE_DIR__";

/** The rc file for each shell. pwsh asks the shell itself, as windows.md and D-18 expect. */
export async function profilePath(ctx: Ctx, kind: ShellKind): Promise<string> {
  if (kind === "bash") return path.join(ctx.home, ".bashrc");
  if (kind === "zsh") return path.join(ctx.home, ".zshrc");
  const r = await ctx.run("pwsh", ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], { timeoutMs: 30000 });
  const out = r.stdout.trim();
  if (r.code !== 0 || out === "") throw new Error(`could not read $PROFILE from pwsh: ${r.stderr.trim() || `code ${r.code}`}`);
  return out;
}

/** Writes the marked block (exactly two body lines in D-18's layout) once; a block already present is left alone. */
export function addBlock(text: string, block: string[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.includes(SHELL_BEGIN)) return text;
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  return text + lead + block.join("\n") + "\n";
}

/** Removes the first marked block (markers included) and returns the rest; text with no block is returned unchanged. */
export function removeBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.replace(/\r$/, "") === SHELL_BEGIN);
  if (start === -1) return text;
  const end = lines.findIndex((l, i) => i > start && l.replace(/\r$/, "") === SHELL_END);
  if (end === -1) return text;
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

/** mc install shell --pwsh|--bash|--zsh: D-18 and ingest.md 6.2. */
export async function installShell(ctx: Ctx, kind: ShellKind): Promise<number> {
  const ext = EXT[kind];
  let profile: string;
  try {
    profile = await profilePath(ctx, kind);
  } catch (err) {
    ctx.err(`shell: ${(err as Error).message}\n`);
    return 1;
  }
  const source = path.join(ctx.layout.shellAssetsDir, `mc.${ext}`);
  if (!existsSync(source)) {
    ctx.err(`shell: snippet not found: ${source}\n`);
    return 1;
  }
  prepareLaunchers(ctx);
  const snippetOut = path.join(ctx.stateDir, "shell", `mc.${ext}`);
  const envFile = path.join(ctx.stateDir, "shell.env");
  const configFile = path.join(ctx.configDir, "config.json");
  const block = [SHELL_BEGIN, `. "${fwd(snippetOut)}"`, SHELL_END];

  // config.json: adapters.shell.enabled = true, every other key kept; the previous value is recorded for uninstall.
  let cfg: ReturnType<typeof readJsonFile>;
  try {
    cfg = readJsonFile(configFile);
  } catch (err) {
    ctx.err(`${(err as Error).message}\nNo change was written.\n`);
    return 1;
  }
  const root: unknown = cfg.exists ? cfg.value : {};
  if (!isObject(root)) {
    ctx.err(`${configFile}: top level is not a JSON object. No change was written.\n`);
    return 1;
  }
  const adapters: unknown = root.adapters === undefined ? {} : root.adapters;
  if (!isObject(adapters)) {
    ctx.err(`${configFile}: "adapters" is not an object. No change was written.\n`);
    return 1;
  }
  const shellCfg: unknown = adapters.shell === undefined ? {} : adapters.shell;
  if (!isObject(shellCfg)) {
    ctx.err(`${configFile}: "adapters.shell" is not an object. No change was written.\n`);
    return 1;
  }
  const manifest = readManifest(ctx);
  const existing = isObject(manifest.shell) ? manifest.shell : null;
  const previous = existing && isObject(existing.config) ? existing.config.previousEnabled : shellCfg.enabled;
  shellCfg.enabled = true;
  adapters.shell = shellCfg;
  root.adapters = adapters;
  const cfgText = jsonText(root);

  // The snippet copy: the T053 placeholder replaced by the resolved stateDir (D-30). The repo asset is never changed.
  const snippet = readFileSync(source, "utf8").split(PLACEHOLDER).join(fwd(ctx.stateDir));
  writeAtomic(snippetOut, snippet);
  writeAtomic(envFile, `MC_NODE=${fwd(ctx.nodePath)}\nMC_HOOK_JS=${fwd(hookJsPath(ctx))}\nMC_OTEL_DIR=${fwd(path.join(ctx.stateDir, "otel"))}\n`);
  if (!cfg.exists || cfgText !== cfg.raw) writeWithBackup(ctx, configFile, cfgText);

  const profileText = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  const next = addBlock(profileText, block);
  if (next !== profileText) writeWithBackup(ctx, profile, next);

  const profiles = existing && isObject(existing.profiles) ? { ...existing.profiles } : {};
  profiles[kind] = { profile, snippet: snippetOut, block };
  manifest.shell = {
    profiles,
    envFile,
    config: { path: configFile, previousEnabled: previous === undefined ? null : previous },
  };
  saveManifest(ctx, manifest);
  ctx.out(`shell: ${kind} block written to ${profile}\n`);
  return 0;
}

/** mc uninstall shell: removes the marked blocks, the snippet copies, shell.env, and restores adapters.shell.enabled. */
export async function uninstallShell(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest.shell;
  if (!isObject(entry)) {
    ctx.out("shell: not installed by mc\n");
    return 0;
  }
  // Every step is tolerant: a problem is a warning, and the manifest entry is always removed at the end,
  // so a damaged file can never make uninstall fail on every rerun.
  const warn = (msg: string): void => ctx.err(`shell: warning: ${msg}\n`);
  const profiles = isObject(entry.profiles) ? entry.profiles : {};
  for (const p of Object.values(profiles)) {
    if (!isObject(p)) continue;
    const profile = String(p.profile);
    try {
      if (existsSync(profile)) {
        const text = readFileSync(profile, "utf8");
        const next = removeBlock(text);
        if (next !== text) writeWithBackup(ctx, profile, next);
      }
    } catch (err) {
      warn(`could not remove the block from ${profile}: ${(err as Error).message}`);
    }
    if (typeof p.snippet === "string") rmSync(p.snippet, { force: true });
  }
  if (typeof entry.envFile === "string") rmSync(entry.envFile, { force: true });

  const cfg = isObject(entry.config) ? entry.config : null;
  if (cfg && existsSync(String(cfg.path))) {
    const file = String(cfg.path);
    try {
      const r = readJsonFile(file);
      if (isObject(r.value)) {
        const root = r.value;
        const adapters = isObject(root.adapters) ? root.adapters : null;
        const shellCfg = adapters && isObject(adapters.shell) ? adapters.shell : null;
        if (adapters && shellCfg) {
          if (cfg.previousEnabled === null) delete shellCfg.enabled;
          else shellCfg.enabled = cfg.previousEnabled;
          if (Object.keys(shellCfg).length === 0) delete adapters.shell;
          if (Object.keys(adapters).length === 0) delete root.adapters;
          writeWithBackup(ctx, file, jsonText(root));
        }
      }
    } catch (err) {
      warn(`adapters.shell.enabled was not restored in ${file}: ${(err as Error).message}`);
    }
  }
  delete manifest.shell;
  saveManifest(ctx, manifest);
  ctx.out("shell: removed\n");
  return 0;
}
