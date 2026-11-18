import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { jsonText, lineDiff, readJsonFile, writeAtomic, writeWithBackup } from "./json-edit.js";
import { type Ctx, fwd, hookJsPath, isObject, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

export interface CopilotEvent {
  event: string;
  timeoutSec: number;
}

/** D-36: PascalCase names make Copilot send snake_case payloads (the Claude Code shape). SessionEnd is the short one. */
export const COPILOT_EVENTS: CopilotEvent[] = [
  { event: "SessionStart", timeoutSec: 5 },
  { event: "UserPromptSubmit", timeoutSec: 5 },
  { event: "PermissionRequest", timeoutSec: 5 },
  { event: "Notification", timeoutSec: 5 },
  { event: "PostToolUse", timeoutSec: 5 },
  { event: "PostToolUseFailure", timeoutSec: 5 },
  { event: "Stop", timeoutSec: 5 },
  { event: "SessionEnd", timeoutSec: 2 },
];

/** Backups writeWithBackup makes of mission-control.json: the only names uninstall may delete. */
const BACKUP_RE = /^mission-control\.json\.mc-backup-\d{14}(-\d+)?$/;

function backupNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => BACKUP_RE.test(f)) : [];
}

/** The file mission control owns inside Copilot's user hooks directory ($COPILOT_HOME or ~/.copilot). */
export function hooksFile(ctx: Ctx): string {
  const base = ctx.env.COPILOT_HOME ? ctx.env.COPILOT_HOME : path.join(ctx.home, ".copilot");
  return path.join(base, "hooks", "mission-control.json");
}

const execPath = (ctx: Ctx): string => fwd(ctx.nodePath);
const argsFor = (ctx: Ctx, event: string): string[] => [fwd(hookJsPath(ctx)), "copilot-cli", event];

function sameArgs(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

function endsMc(s: unknown): boolean {
  return typeof s === "string" && s.replace(/\\/g, "/").endsWith("mc-hook.js");
}

/** Copilot identification (D-41.4): args of length 3, args[0] ends in mc-hook.js, args[1] is copilot-cli, args[2] is the event. */
export function isMcCopilot(h: unknown, event: string): h is Record<string, unknown> {
  return (
    isObject(h) &&
    Array.isArray(h.args) &&
    h.args.length === 3 &&
    endsMc(h.args[0]) &&
    h.args[1] === "copilot-cli" &&
    h.args[2] === event
  );
}

/** Sets the four wanted keys in place (existing key order kept); true when any of them changed. */
function repairCopilot(h: Record<string, unknown>, spec: CopilotEvent, exec: string, args: string[]): boolean {
  const changed = h.type !== "command" || h.exec !== exec || !sameArgs(h.args, args) || h.timeoutSec !== spec.timeoutSec;
  h.type = "command";
  h.exec = exec;
  h.args = [...args];
  h.timeoutSec = spec.timeoutSec;
  return changed;
}

type Loaded = { file: string; raw: string; root: Record<string, unknown>; hooks: Record<string, unknown> };

/** Reads and validates the file; returns an error message instead of touching anything malformed. */
function load(ctx: Ctx): Loaded | string {
  const file = hooksFile(ctx);
  let read: ReturnType<typeof readJsonFile>;
  try {
    read = readJsonFile(file);
  } catch (err) {
    return `${(err as Error).message}\nNo change was written.\n`;
  }
  const root: unknown = read.exists ? read.value : { version: 1 };
  if (!isObject(root)) return `${file}: top level is not a JSON object. No change was written.\n`;
  if (root.version !== 1) return `${file}: "version" is not 1. No change was written.\n`;
  const hooks: unknown = root.hooks === undefined ? {} : root.hooks;
  if (!isObject(hooks)) return `${file}: "hooks" is not an object. No change was written.\n`;
  for (const [k, v] of Object.entries(hooks)) {
    if (!Array.isArray(v)) return `${file}: hooks.${k} is not an array. No change was written.\n`;
  }
  return { file, raw: read.raw, root, hooks };
}

/** mc install copilot: ingest.md 6.3. Writes only <copilot home>/hooks/mission-control.json. */
export async function installCopilot(ctx: Ctx): Promise<number> {
  const l = load(ctx);
  if (typeof l === "string") {
    ctx.err(l);
    return 1;
  }
  const { file, root, hooks } = l;
  const exec = execPath(ctx);
  let added = 0;
  let repaired = 0;
  let removed = 0;
  for (const spec of COPILOT_EVENTS) {
    const args = argsFor(ctx, spec.event);
    const list = (hooks[spec.event] ?? []) as unknown[];
    const next: unknown[] = [];
    let found = false;
    for (const h of list) {
      if (!isMcCopilot(h, spec.event)) {
        next.push(h);
      } else if (!found) {
        found = true;
        if (repairCopilot(h, spec, exec, args)) repaired++;
        next.push(h);
      } else {
        removed++;
      }
    }
    if (!found) {
      next.push({ type: "command", exec, args, timeoutSec: spec.timeoutSec });
      added++;
    }
    hooks[spec.event] = next;
  }
  root.hooks = hooks;
  const after = jsonText(root);
  const changed = added + repaired + removed > 0;
  if (ctx.dryRun) {
    ctx.out(changed ? lineDiff(l.raw, after) : `${file}: no change\n`);
    return 0;
  }
  prepareLaunchers(ctx);
  const dir = path.dirname(file);
  const backupsBefore = new Set(backupNames(dir));
  const dirExisted = existsSync(dir);
  if (changed) writeWithBackup(ctx, file, after);
  const manifest = readManifest(ctx);
  const prev = isObject(manifest["copilot-cli"]) ? manifest["copilot-cli"] : {};
  const prevBackups = Array.isArray(prev.backups) ? prev.backups.map(String) : [];
  const newBackups = backupNames(dir).filter((n) => !backupsBefore.has(n));
  manifest["copilot-cli"] = {
    hooksPath: file,
    events: COPILOT_EVENTS.map((e) => e.event),
    exec,
    hookJs: fwd(hookJsPath(ctx)),
    // Uninstall removes the hooks directory only if this installer created it; an earlier install's record wins.
    createdHooksDir: prev.createdHooksDir === true || (changed && !dirExisted),
    backups: [...prevBackups, ...newBackups],
  };
  saveManifest(ctx, manifest);
  ctx.out(
    changed
      ? `copilot-cli: added ${added} hook(s), repaired ${repaired}, removed ${removed} duplicate(s) in ${file}\n`
      : `copilot-cli: hooks already in ${file}\n`,
  );
  return 0;
}

/** mc uninstall copilot: removes exactly the recorded entries; deletes the file when nothing else is left in it. */
export async function uninstallCopilot(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest["copilot-cli"];
  if (!isObject(entry)) {
    ctx.out("copilot-cli: not installed by mc (no entry in install-manifest.json)\n");
    return 0;
  }
  const file = String(entry.hooksPath);
  const dir = path.dirname(file);
  let removed = 0;
  let read: ReturnType<typeof readJsonFile>;
  try {
    read = readJsonFile(file);
  } catch (err) {
    ctx.err(`${(err as Error).message}\nNo change was written.\n`);
    return 1;
  }
  if (read.exists) {
    const root = read.value;
    if (!isObject(root)) {
      ctx.err(`${file}: top level is not a JSON object. No change was written.\n`);
      return 1;
    }
    const hooks = root.hooks;
    if (isObject(hooks)) {
      for (const ev of Object.keys(hooks)) {
        const list = hooks[ev];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((h) => !isMcCopilot(h, ev));
        removed += list.length - kept.length;
        if (kept.length === 0) {
          if (list.length > 0) delete hooks[ev];
        } else hooks[ev] = kept;
      }
      if (removed > 0 && Object.keys(hooks).length === 0) delete root.hooks;
    }
    if (removed > 0) {
      // No new backup here: the install-time backup holds the user's original, and a backup made now would be
      // an unrecorded leftover (the real run showed exactly that).
      writeAtomic(file, jsonText(root));
      const rest = Object.keys(root).filter((k) => k !== "version");
      if (rest.length === 0) unlinkSync(file);
    }
  }
  // Only backups recorded in the manifest (and matching the backup name shape) are deleted.
  const backups = Array.isArray(entry.backups) ? entry.backups.map(String) : [];
  let deletedBackups = 0;
  for (const name of backups) {
    const target = path.join(dir, name);
    if (!BACKUP_RE.test(name) || !existsSync(target)) continue;
    unlinkSync(target);
    deletedBackups++;
  }
  let removedDir = false;
  if (entry.createdHooksDir === true && existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    removedDir = true;
  }
  delete manifest["copilot-cli"];
  saveManifest(ctx, manifest);
  ctx.out(`copilot-cli: removed ${removed} hook(s) from ${file}\n`);
  if (deletedBackups > 0) ctx.out(`copilot-cli: deleted ${deletedBackups} backup file(s) it created\n`);
  if (removedDir) ctx.out(`copilot-cli: removed the hooks directory it created (${dir})\n`);
  return 0;
}
