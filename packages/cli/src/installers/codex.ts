import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { lineDiff, writeWithBackup } from "./json-edit.js";
import { type Ctx, fwd, hookJsPath, isObject, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

export function codexConfigPath(ctx: Ctx): string {
  return path.join(ctx.home, ".codex", "config.toml");
}

/** Codex identification (D-41.4): argv[1] ends in mc-hook.js and argv[2] is codex; a wrapped line has more after that. */
export function isMcNotify(argv: string[]): boolean {
  const first: unknown = argv[1];
  return argv.length >= 3 && typeof first === "string" && first.replace(/\\/g, "/").endsWith("mc-hook.js") && argv[2] === "codex";
}

/** One single-line `notify = [...]` statement, strings written the way codexNotifyLine writes them. */
function codexArgvLine(argv: string[]): string {
  return `notify = [${argv.map((s) => `"${s}"`).join(", ")}]`;
}

/** ingest.md 6.1: the one line mc owns in config.toml. */
export function codexNotifyLine(ctx: Ctx, chain?: string[]): string {
  const base = `notify = ["${fwd(ctx.nodePath)}", "${fwd(hookJsPath(ctx))}", "codex"`;
  if (chain === undefined) return base + "]";
  return `${base}, "--chain", "${Buffer.from(JSON.stringify(chain), "utf8").toString("base64url")}"]`;
}

/**
 * Parses the top-level `notify = [ "a", 'b', ... ]` statement starting at lines[start] (it may span
 * lines). Returns the index of its last line and the argv, or null when it is not a plain string array.
 */
export function parseNotify(lines: string[], start: number): { end: number; argv: string[] } | null {
  const text = lines.slice(start).join("\n");
  let i = text.indexOf("=") + 1;
  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "#") while (i < text.length && text[i] !== "\n") i++;
      else return;
    }
  };
  skip();
  if (text[i] !== "[") return null;
  i++;
  const argv: string[] = [];
  for (;;) {
    skip();
    const c = text[i];
    if (c === "]") break;
    if (c !== '"' && c !== "'") return null;
    if (text.startsWith(c.repeat(3), i)) return null;
    let j = i + 1;
    while (j < text.length && text[j] !== c && text[j] !== "\n") j += c === '"' && text[j] === "\\" ? 2 : 1;
    if (text[j] !== c) return null;
    const raw = text.slice(i + 1, j);
    if (c === "'") argv.push(raw);
    else {
      try {
        argv.push(JSON.parse(`"${raw}"`) as string);
      } catch {
        return null;
      }
    }
    i = j + 1;
    skip();
    if (text[i] === ",") i++;
    else if (text[i] !== "]") return null;
  }
  const close = i;
  i++;
  while (text[i] === " " || text[i] === "\t") i++;
  if (i < text.length && text[i] !== "\n" && text[i] !== "\r" && text[i] !== "#") return null;
  if (argv.length === 0) return null;
  return { end: start + text.slice(0, close).split("\n").length - 1, argv };
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.replace(/\r?\n$/, "");
  return { lines: text === "" ? [] : body.split(/\r?\n/), eol };
}

/**
 * Index of the first top-level table header ([name] or [[name]]), or -1. A light TOML scan: it tracks
 * bracket and brace depth and basic, literal and multi-line strings, so a `[` on a continuation line
 * of an array or inline value is not taken for a header.
 */
export function firstTableIndex(lines: string[]): number {
  let depth = 0;
  let str: '"' | "'" | '"""' | "'''" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (str === null && depth === 0 && /^\s*\[/.test(l)) return i;
    let j = 0;
    while (j < l.length) {
      const c = l[j] ?? "";
      if (str !== null) {
        if (str === '"""' || str === "'''") {
          if (l.startsWith(str, j)) {
            str = null;
            j += 3;
            continue;
          }
        } else if (c === "\\" && str === '"') {
          j += 2;
          continue;
        } else if (c === str) {
          str = null;
        }
        j++;
        continue;
      }
      if (c === "#") break;
      if (l.startsWith('"""', j)) {
        str = '"""';
        j += 3;
        continue;
      }
      if (l.startsWith("'''", j)) {
        str = "'''";
        j += 3;
        continue;
      }
      if (c === '"' || c === "'") str = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
      j++;
    }
  }
  return -1;
}

/** mc install codex (ingest.md 6.1): line edit, notify before the first [table]; an existing notify is wrapped (D-37) and restored on uninstall. */
export async function installCodex(ctx: Ctx): Promise<number> {
  const file = codexConfigPath(ctx);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { lines, eol } = splitLines(text);
  const tableAt = firstTableIndex(lines);
  const top = tableAt === -1 ? lines.length : tableAt;
  const existingAt = lines.slice(0, top).findIndex((l) => /^\s*notify\s*=/.test(l));
  let line = codexNotifyLine(ctx);
  let original: string[] | undefined;
  const found = existingAt === -1 ? null : parseNotify(lines, existingAt);
  if (existingAt !== -1 && found === null) {
    ctx.err(`${file} sets notify in a form mc cannot wrap, so mc did not change it. Merge by hand, adding:
${line}
`);
    return 1;
  }
  prepareLaunchers(ctx);
  const mcLine = found !== null && isMcNotify(found.argv);
  if (found !== null && mcLine) {
    // D-41.4: an mc line is rewritten in place, its --chain argument kept, never wrapped.
    line = codexArgvLine([fwd(ctx.nodePath), fwd(hookJsPath(ctx)), "codex", ...found.argv.slice(3)]);
    if (found.end === existingAt && lines[existingAt]?.trim() === line) {
      ctx.out(`codex: notify already installed in ${file}
`);
      return 0;
    }
    lines.splice(existingAt, found.end - existingAt + 1, line);
  } else if (found !== null) {
    original = lines.slice(existingAt, found.end + 1);
    line = codexNotifyLine(ctx, found.argv);
    lines.splice(existingAt, found.end - existingAt + 1, line);
  } else if (tableAt === -1) lines.push(line);
  else lines.splice(tableAt, 0, line);
  const next = lines.join(eol) + eol;

  if (ctx.dryRun) {
    ctx.out(lineDiff(text, next));
    return 0;
  }
  writeWithBackup(ctx, file, next);
  const manifest = readManifest(ctx);
  if (mcLine) {
    // The user's original (and its eol) recorded by an earlier wrap stays; only the line changes.
    const prev = isObject(manifest.codex) ? manifest.codex : {};
    const entry: Record<string, unknown> = { path: file, line };
    if (prev.original !== undefined) entry.original = prev.original;
    if (prev.eol !== undefined) entry.eol = prev.eol;
    manifest.codex = entry;
  } else manifest.codex = original === undefined ? { path: file, line } : { path: file, line, original, eol };
  saveManifest(ctx, manifest);
  ctx.out(`codex: notify added to ${file}\n`);
  return 0;
}

/** mc uninstall codex: removes the recorded notify line only. */
export async function uninstallCodex(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest.codex;
  if (!isObject(entry)) {
    ctx.out("codex: not installed by mc\n");
    return 0;
  }
  const file = String(entry.path);
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const { lines, eol } = splitLines(text);
    // D-41.4: the mc line is found by the identification rule, not by the recorded text (it may be rewritten out of band).
    const at = lines.findIndex((l) => /^\s*notify\s*=/.test(l));
    const found = at === -1 ? null : parseNotify(lines, at);
    if (found !== null && isMcNotify(found.argv)) {
      const orig = Array.isArray(entry.original) ? entry.original.map(String) : [];
      lines.splice(at, found.end - at + 1, ...orig);
      writeWithBackup(ctx, file, lines.length === 0 ? "" : lines.join(eol) + eol);
    }
  }
  delete manifest.codex;
  saveManifest(ctx, manifest);
  ctx.out(`codex: removed notify from ${file}\n`);
  return 0;
}
