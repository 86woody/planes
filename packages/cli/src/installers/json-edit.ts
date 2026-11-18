import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class ConfigParseError extends Error {}

export interface ReadResult {
  exists: boolean;
  raw: string;
  value: unknown;
}

/** Missing file: exists false. Invalid JSON throws ConfigParseError and the caller leaves the file alone. */
export function readJsonFile(file: string): ReadResult {
  if (!existsSync(file)) return { exists: false, raw: "", value: undefined };
  const raw = readFileSync(file, "utf8");
  try {
    return { exists: true, raw, value: JSON.parse(raw) };
  } catch (err) {
    throw new ConfigParseError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

/** claude-hooks.md 3 and the config contract: 2-space indent, trailing newline. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** yyyyMMddHHmmss in local time, the suffix of every backup file. */
export function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export interface WriteState {
  now: Date;
  /** Files already backed up in this run; the backup is taken before the first write only. */
  backedUp: Set<string>;
}

/** Temp file in the same directory, then rename, so a crash never leaves a half-written file. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.mc-tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** Writes a user-owned file. Before the first write to an existing file, copies it to `<file>.mc-backup-<stamp>`. */
export function writeWithBackup(state: WriteState, file: string, text: string): void {
  if (existsSync(file) && !state.backedUp.has(file)) {
    state.backedUp.add(file);
    const base = `${file}.mc-backup-${stamp(state.now)}`;
    let target = base;
    let n = 2;
    while (existsSync(target)) target = `${base}-${n++}`;
    copyFileSync(file, target);
  }
  writeAtomic(file, text);
}

/** Plain line diff (LCS) of two texts, every line prefixed by ' ', '-' or '+'. Used by --dry-run. */
export function lineDiff(before: string, after: string): string {
  const split = (s: string): string[] => (s === "" ? [] : s.replace(/\r?\n$/, "").split(/\r?\n/));
  const a = split(before);
  const b = split(after);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out.join("\n") + "\n";
}
