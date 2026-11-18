import { execFile } from "node:child_process";
import path from "node:path";

export interface GitInfo {
  project: string;
  branch: string | null;
}

const TTL_MS = 30_000;
const TIMEOUT_MS = 2_000;
const cache = new Map<string, { value: GitInfo; at: number }>();

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function exitCodeOf(err: unknown): number | null {
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function topLevelProject(toplevel: string | undefined, cwd: string): string {
  const line = (toplevel ?? "").trim();
  return line === "" ? path.basename(cwd) : path.basename(line);
}

async function probe(cwd: string): Promise<GitInfo> {
  const fallback: GitInfo = { project: path.basename(cwd), branch: null };
  try {
    const lines = (await runGit(["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"])).split(/\r?\n/);
    const project = topLevelProject(lines[0], cwd);
    const branch = (lines[1] ?? "").trim();
    return { project, branch: branch === "" || branch === "HEAD" ? null : branch };
  } catch (err) {
    // Exit 128 also covers a repo with no commits, where --abbrev-ref HEAD cannot resolve.
    if (exitCodeOf(err) !== 128) return fallback;
  }
  try {
    const toplevel = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
    const project = topLevelProject(toplevel.split(/\r?\n/)[0], cwd);
    try {
      const branch = (await runGit(["-C", cwd, "symbolic-ref", "--short", "HEAD"])).trim();
      return { project, branch: branch === "" ? null : branch };
    } catch {
      return { project, branch: null };
    }
  } catch {
    return fallback;
  }
}

export async function readGit(cwd: string): Promise<{ project: string; branch: string | null }> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value };
  const value = await probe(cwd);
  cache.set(cwd, { value, at: Date.now() });
  return { ...value };
}
