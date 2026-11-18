import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IngestOrigin, Host } from "@mc/contracts";
import { exec } from "../../src/exec.js";
import { ancestry, processAlive, processStartTime } from "../../src/process/index.js";
import { createDiscover } from "../../src/windows/discover.js";
import type { PlatformEnv } from "../../src/types.js";

const enabled = process.env.MC_OS_TESTS === "1" && process.platform === "win32";
const env = { stateDir: "", config: {}, repoRoot: "", displayEnv: () => process.env } as unknown as PlatformEnv;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  const done = once(child, "exit").then(() => undefined);
  child.kill();
  return done;
}

describe.skipIf(!enabled)("windows discovery against real windows (MC_OS_TESTS=1)", () => {
  it("WO-01 a spawned conhost cmd window resolves to ConsoleWindowClass", async () => {
    const marker = `MC-TEST-${randomBytes(4).toString("hex")}`;
    // Started through PowerShell: a Node-spawned console can be handed to Windows Terminal
    // (Windows 11 default terminal), which would not give a ConsoleWindowClass window.
    const launch = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Start-Process -FilePath conhost.exe -ArgumentList 'cmd.exe','/k','title ${marker}' -PassThru).Id`,
      ],
      { timeoutMs: 8000 },
    );
    const conhostPid = Number(launch.stdout.trim());
    expect(Number.isInteger(conhostPid) && conhostPid > 0, "conhost started").toBe(true);
    try {
      const discover = createDiscover({ exec, env });
      // The console window is owned by the cmd.exe that conhost hosts (not by conhost itself).
      let found: { handle: string; pid: number } | undefined;
      const deadline = Date.now() + 1900;
      while (Date.now() < deadline && !found) {
        const wins = await discover.listWindows(["cmd", "conhost"]);
        const hit = wins.find((w) => w.title.includes(marker));
        if (hit) found = { handle: hit.handle, pid: hit.pid };
        else await sleep(100);
      }
      expect(found, "console window with marker title").toBeDefined();

      const origin = {
        os: "windows",
        env: {},
        ancestry: await ancestry(found?.pid ?? 0),
        console: null,
      } as unknown as IngestOrigin;
      const host = { kind: "conhost", app: "conhost.exe", display: "win32", multiplexer: null, os: "windows" } as unknown as Host;
      const t = await discover.resolveTarget(origin, host);
      expect(t.window?.handle).toBe(found?.handle);
      expect(t.capability).toBe("full");
    } finally {
      await exec("taskkill", ["/pid", String(conhostPid), "/T", "/F"], { timeoutMs: 5000 });
    }
  }, 15_000);

  it("WO-05 processAlive true with start time, false with another, false after exit", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid ?? 0;
    try {
      const startTime = await processStartTime(pid);
      expect(startTime).not.toBeNull();
      expect(await processAlive(pid, startTime)).toBe(true);
      expect(await processAlive(pid, "1")).toBe(false);
    } finally {
      await kill(child);
    }
    expect(await processAlive(pid, null)).toBe(false);
  }, 15_000);

  it("WO-08 ancestry of a child node process lists this process with its name", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore", windowsHide: true });
    try {
      const chain = await ancestry(child.pid ?? 0);
      const me = chain.find((p) => p.pid === process.pid);
      expect(me).toBeDefined();
      expect(me?.name.toLowerCase().replace(/\.exe$/, "")).toBe("node");
    } finally {
      await kill(child);
    }
  }, 15_000);
});
