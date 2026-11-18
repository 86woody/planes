import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ancestry, processAlive, processStartTime } from "../src/process/index.js";
import { parseLinuxStat, parsePsLstart, walkAncestry, normName } from "../src/process/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("process utilities", () => {
  test('PR-01 parseLinuxStat handles a comm containing ") ("', () => {
    const line = "777 (a) (b) S 100 777 777 0 -1 4194560 10 0 0 0 1 2 0 0 20 0 1 0 555 1000 200";
    const s = parseLinuxStat(line);
    expect(s.comm).toBe("a) (b");
    expect(s.pid).toBe(777);
    expect(s.ppid).toBe(100);
    expect(s.startTime).toBe("555");
  });

  test("PR-02 parseLinuxStat extracts ppid and starttime", () => {
    const line =
      "4242 (node) S 4001 4001 4001 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 1 0 123456 9999 300";
    const s = parseLinuxStat(line);
    expect(s).toEqual({ pid: 4242, ppid: 4001, startTime: "123456", comm: "node" });
  });

  test("PR-03 parsePsLstart parses the recorded fixture", () => {
    const text = readFileSync(path.join(here, "fixtures/process/ps-lstart.txt"), "utf8");
    const table = parsePsLstart(text);
    expect(table.size).toBe(3);
    expect(table.get(501)).toEqual({ ppid: 1, startTime: "Sun Nov  8 20:15:03 2026", name: "foo" });
    expect(table.get(612)).toEqual({
      ppid: 501,
      startTime: "Mon Nov  9 08:02:44 2026",
      name: "Terminal",
    });
    expect(table.get(1)?.name).toBe("launchd");
  });

  test("PR-04 ancestry of a spawned child starts with the child then this process", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},3000)"], { stdio: "ignore" });
    try {
      const chain = await ancestry(child.pid!);
      expect(chain[0]?.pid).toBe(child.pid);
      expect(normName(chain[0]?.name ?? "")).toBe("node");
      expect(chain[1]?.pid).toBe(process.pid);
    } finally {
      child.kill();
      await once(child, "exit");
    }
  });

  test("PR-05 processAlive is true for process.pid with its own start time", async () => {
    const start = await processStartTime(process.pid);
    expect(start).not.toBeNull();
    expect(await processAlive(process.pid, start)).toBe(true);
  });

  test("PR-06 processAlive is false with a wrong start time", async () => {
    expect(await processAlive(process.pid, "0")).toBe(false);
  });

  test("PR-07 processAlive is false after a child exits", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], { stdio: "ignore" });
    const pid = child.pid!;
    const start = await processStartTime(pid);
    expect(start).not.toBeNull();
    expect(await processAlive(pid, start)).toBe(true);
    await once(child, "exit");
    expect(await processAlive(pid, start)).toBe(false);
  });

  test("PR-08 ancestry stops at 16 entries", () => {
    // Fake table: every pid's parent is pid + 1, none of them a stop process.
    const lookup = (pid: number) => ({ pid, ppid: pid + 1, name: `p${pid}.exe`, startTime: "1" });
    const chain = walkAncestry(100, lookup);
    expect(chain.length).toBe(16);
    expect(chain[0]?.pid).toBe(100);
    expect(chain[15]?.pid).toBe(115);
  });
});
