import path from "node:path";
import { installUri } from "./uri.js";
import { jsonText, lineDiff, readJsonFile, writeWithBackup } from "./json-edit.js";
import { type Ctx, fwd, hookJsPath, isObject, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

export interface HookEvent {
  event: string;
  async: boolean;
  timeout: number;
}

/** claude-hooks.md 1: one matcher group per event; SessionEnd is the only synchronous entry. */
export const CLAUDE_EVENTS: HookEvent[] = [
  { event: "SessionStart", async: true, timeout: 5 },
  { event: "UserPromptSubmit", async: true, timeout: 5 },
  { event: "PermissionRequest", async: true, timeout: 5 },
  { event: "Notification", async: true, timeout: 5 },
  { event: "PostToolUse", async: true, timeout: 5 },
  { event: "PostToolUseFailure", async: true, timeout: 5 },
  { event: "Stop", async: true, timeout: 5 },
  { event: "StopFailure", async: true, timeout: 5 },
  { event: "SessionEnd", async: false, timeout: 2 },
];

function endsMc(s: unknown): boolean {
  return typeof s === "string" && s.replace(/\\/g, "/").endsWith("mc-hook.js");
}

/** claude-hooks.md 2 (D-41.4): args of length 2, args[0] ends in mc-hook.js, args[1] is the adapter. */
export function isMcClaude(h: unknown): h is Record<string, unknown> {
  return isObject(h) && Array.isArray(h.args) && h.args.length === 2 && endsMc(h.args[0]) && h.args[1] === "claude-code";
}

export function settingsPath(ctx: Ctx): string {
  return ctx.env.CLAUDE_CONFIG_DIR
    ? path.join(ctx.env.CLAUDE_CONFIG_DIR, "settings.json")
    : path.join(ctx.home, ".claude", "settings.json");
}

function hookCommand(ctx: Ctx): string {
  return fwd(ctx.nodePath);
}

function hookArgs(ctx: Ctx): string[] {
  return [fwd(hookJsPath(ctx)), "claude-code"];
}

function sameArgs(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The hooks array of a matcher group, or null when the group is not shaped like one. */
function hooksOf(g: unknown): unknown[] | null {
  return isObject(g) && Array.isArray(g.hooks) ? (g.hooks as unknown[]) : null;
}

function hookObject(ctx: Ctx, spec: HookEvent): Record<string, unknown> {
  return {
    type: "command",
    command: hookCommand(ctx),
    args: hookArgs(ctx),
    async: spec.async,
    timeout: spec.timeout,
  };
}

/** Sets the five wanted keys in place (existing key order kept); true when any of the five values changed. */
function repairClaude(h: Record<string, unknown>, spec: HookEvent, command: string, args: string[]): boolean {
  const changed =
    h.type !== "command" || h.command !== command || !sameArgs(h.args, args) || h.async !== spec.async || h.timeout !== spec.timeout;
  h.type = "command";
  h.command = command;
  h.args = [...args];
  h.async = spec.async;
  h.timeout = spec.timeout;
  return changed;
}

interface ClaudeWalk {
  groups: unknown[];
  found: boolean;
  repaired: number;
  removed: number;
}

/** Walks one event's groups: the first mc object is repaired in place, later ones are removed (D-41.4). */
function walkClaude(groups: unknown[], spec: HookEvent, command: string, args: string[]): ClaudeWalk {
  const walk: ClaudeWalk = { groups: [], found: false, repaired: 0, removed: 0 };
  for (const g of groups) {
    const gh = hooksOf(g);
    if (!isObject(g) || gh === null || gh.length === 0) {
      walk.groups.push(g);
      continue;
    }
    const keep: unknown[] = [];
    for (const h of gh) {
      if (!isMcClaude(h)) {
        keep.push(h);
      } else if (!walk.found) {
        walk.found = true;
        if (repairClaude(h, spec, command, args)) walk.repaired++;
        keep.push(h);
      } else {
        walk.removed++;
      }
    }
    if (keep.length === gh.length) {
      walk.groups.push(g);
      continue;
    }
    if (keep.length === 0) continue;
    g.hooks = keep;
    walk.groups.push(g);
  }
  return walk;
}

/** mc install claude-code: claude-hooks.md 1-3, then the uri-handler once on Windows and Linux (windows.md 5.1). */
export async function installClaude(ctx: Ctx): Promise<number> {
  const file = settingsPath(ctx);
  let read: ReturnType<typeof readJsonFile>;
  try {
    read = readJsonFile(file);
  } catch (err) {
    ctx.err(`${(err as Error).message}\nNo change was written.\n`);
    return 1;
  }
  const root: unknown = read.exists ? read.value : {};
  if (!isObject(root)) {
    ctx.err(`${file}: top level is not a JSON object. No change was written.\n`);
    return 1;
  }
  const hooks: unknown = root.hooks === undefined ? {} : root.hooks;
  if (!isObject(hooks)) {
    ctx.err(`${file}: "hooks" is not an object. No change was written.\n`);
    return 1;
  }
  const command = hookCommand(ctx);
  const args = hookArgs(ctx);
  let added = 0;
  let repaired = 0;
  let removed = 0;
  for (const spec of CLAUDE_EVENTS) {
    const groups: unknown = hooks[spec.event] === undefined ? [] : hooks[spec.event];
    if (!Array.isArray(groups)) {
      ctx.err(`${file}: hooks.${spec.event} is not an array. No change was written.\n`);
      return 1;
    }
    const walk = walkClaude(groups, spec, command, args);
    repaired += walk.repaired;
    removed += walk.removed;
    if (!walk.found) {
      walk.groups.push({ matcher: "", hooks: [hookObject(ctx, spec)] });
      added++;
    }
    hooks[spec.event] = walk.groups;
  }
  root.hooks = hooks;
  prepareLaunchers(ctx);
  const before = read.raw;
  const after = jsonText(root);
  const changed = added + repaired + removed > 0;

  if (ctx.dryRun) {
    ctx.out(changed ? lineDiff(before, after) : `${file}: no change\n`);
    if (ctx.platform === "win32" || ctx.platform === "linux") ctx.out("would also run: mc install uri-handler\n");
    return 0;
  }

  if (changed) writeWithBackup(ctx, file, after);
  const manifest = readManifest(ctx);
  manifest["claude-code"] = {
    settingsPath: file,
    events: CLAUDE_EVENTS.map((e) => e.event),
    command,
    args,
  };
  saveManifest(ctx, manifest);
  ctx.out(
    changed
      ? `claude-code: added ${added} hook group(s), repaired ${repaired}, removed ${removed} duplicate(s) in ${file}\n`
      : `claude-code: hooks already in ${file}\n`,
  );

  // The hooks are already written and recorded above. A failed URI handler is a warning, not a failed
  // install: claude-hooks.md does not make it a failure, and the handler is retried by its own command.
  // With MC_HOME set (tests, smoke runs) the HKCU or desktop-entry writes are skipped (D-41.6).
  if ((ctx.platform === "win32" || ctx.platform === "linux") && manifest["uri-handler"] === undefined) {
    if (ctx.env.MC_HOME) {
      ctx.out("uri-handler skipped (MC_HOME set)\n");
    } else if ((await installUri(ctx, false)) !== 0) {
      ctx.err("claude-code: warning: hooks are installed, but the URI handler failed (message above). Retry with: mc install uri-handler\n");
    }
  }
  return 0;
}

/** mc uninstall claude-code: removes every hook object matching the identification rule (claude-hooks.md 2). */
export async function uninstallClaude(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest["claude-code"];
  if (!isObject(entry)) {
    ctx.out("claude-code: not installed by mc (no entry in install-manifest.json)\n");
    return 0;
  }
  const file = String(entry.settingsPath);

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
      const hadKeys = Object.keys(hooks).length > 0;
      for (const ev of Object.keys(hooks)) {
        const groups = hooks[ev];
        if (!Array.isArray(groups)) continue;
        let touched = false;
        const kept: unknown[] = [];
        for (const g of groups) {
          const gh = hooksOf(g);
          if (isObject(g) && gh !== null) {
            const kept2 = gh.filter((h) => !isMcClaude(h));
            const n = gh.length - kept2.length;
            if (n > 0) {
              removed += n;
              touched = true;
              g.hooks = kept2;
              if (kept2.length === 0) continue;
            }
          }
          kept.push(g);
        }
        if (touched) {
          if (kept.length === 0) delete hooks[ev];
          else hooks[ev] = kept;
        }
      }
      if (removed > 0 && hadKeys && Object.keys(hooks).length === 0) delete root.hooks;
    }
    if (removed > 0) writeWithBackup(ctx, file, jsonText(root));
  }
  delete manifest["claude-code"];
  saveManifest(ctx, manifest);
  ctx.out(`claude-code: removed ${removed} hook object(s) from ${file}\n`);
  return 0;
}
