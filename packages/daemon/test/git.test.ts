import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGit } from "../src/git.js";

const run = promisify(execFile);
const tmpDirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-git-"));
  tmpDirs.push(dir);
  return dir;
}

async function initRepo(dir: string, branch: string): Promise<void> {
  await run("git", ["init", "-b", branch], { cwd: dir });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

describe("git info", () => {
  it("GI-01 readGit in a temp git repo on branch mc-test returns the repo basename and mc-test", async () => {
    const dir = await tmp();
    await initRepo(dir, "mc-test");

    expect(await readGit(dir)).toEqual({ project: path.basename(dir), branch: "mc-test" });
  });

  it("GI-02 readGit outside a repo returns basename(cwd) and null", async () => {
    const dir = await tmp();

    expect(await readGit(dir)).toEqual({ project: path.basename(dir), branch: null });
  });

  it("GI-03 readGit caches by cwd for 30 s", async () => {
    const dir = await tmp();
    await initRepo(dir, "mc-test");
    expect((await readGit(dir)).branch).toBe("mc-test");

    await run("git", ["checkout", "-q", "-b", "other"], { cwd: dir });
    expect((await readGit(dir)).branch).toBe("mc-test");

    const later = Date.now() + 31_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await readGit(dir)).branch).toBe("other");
  });
});
