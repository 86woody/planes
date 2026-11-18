import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exec } from "../../src/exec.js";
import { createDiscover, findTab } from "../../src/macos/discover.js";
import { screenFrame } from "../../src/macos/focus.js";
import { ancestry, processAlive } from "../../src/process/index.js";
import type { PlatformEnv } from "../../src/types.js";

// Real macOS only, with Automation/Accessibility as the machine has them. Skipped elsewhere.
const onMac = process.platform === "darwin" && process.env.MC_OS_TESTS === "1";
const suite = onMac ? describe : describe.skip;
const env = {} as PlatformEnv;

suite("macOS focus (real OS)", () => {
  it("MO-01 screen-frame returns integer bounds with right > left and bottom > top", async () => {
    const b = await screenFrame(exec);
    expect(b).not.toBeNull();
    if (b === null) return;
    for (const v of [b.left, b.top, b.right, b.bottom]) expect(Number.isInteger(v)).toBe(true);
    expect(b.right).toBeGreaterThan(b.left);
    expect(b.bottom).toBeGreaterThan(b.top);
  });

  it("MO-02 frontmost returns a pid that processAlive accepts", async () => {
    const f = await createDiscover({ exec, env }).foregroundWindow();
    expect(f).not.toBeNull();
    if (f === null) return;
    expect(await processAlive(f.pid, null)).toBe(true);
  });

  it("MO-03 terminal-find with a bogus tty returns {} or a permission_denied classification and never throws", async () => {
    const r = await findTab(exec, "Terminal", "/dev/ttys999999", "");
    expect(["none", "failed", "found"]).toContain(r.kind);
    if (r.kind === "failed") expect(["automation_denied", "other", "timeout"]).toContain(r.reason);
    expect(r.kind).not.toBe("found");
  });

  it("MO-04 processAlive start-time mismatch is false", async () => {
    expect(await processAlive(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
  });

  it("MO-06 ancestry of a child process on macOS lists this process", async () => {
    const child = spawn("sleep", ["5"]);
    try {
      const chain = await ancestry(child.pid ?? 0);
      expect(chain.some((p) => p.pid === process.pid)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
