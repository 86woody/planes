import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OsNotification } from "@mc/contracts";
import { describe, expect, it, vi } from "vitest";
import { createNotify as createWinNotify } from "../../platform/src/windows/notify.js";
import { selectWtTab } from "../../platform/src/windows/focus.js";
import { createNotifyWithConnector } from "../../platform/src/linux/notify.js";
import { scriptPath } from "../../platform/src/macos/discover.js";
import { createNotify as createMacNotify, osascriptArgs } from "../../platform/src/macos/notify.js";
import { layout } from "../../platform/src/layout.js";
import type { PlatformEnv } from "../../platform/src/types.js";
import { startDaemon } from "../src/main.js";

const { spawnToastHost } = vi.hoisted(() => ({
  spawnToastHost: vi.fn(() => () => {
    throw new Error("not spawned");
  }),
}));
vi.mock("../../platform/src/windows/toast-host.js", () => ({
  spawnToastHost,
  createToastHost: () => ({ request: async () => null, dispose: () => undefined }),
  powershellPath: () => "powershell.exe",
}));

// RW-06 needs macos/notify.ts to pick the terminal-notifier backend, which it
// detects with spawnSync("where" | "command -v"). Only that probe is faked.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (_cmd: string, args: readonly string[]) =>
      args.includes("terminal-notifier")
        ? { status: 0, stdout: "/opt/homebrew/bin/terminal-notifier\n" }
        : { status: 1, stdout: "" },
  };
});

const PLATFORM_SRC = fileURLToPath(new URL("../../platform/src/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const env = { repoRoot: "/nonexistent-repo" } as unknown as PlatformEnv;
const stubExec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
const notification = {
  sessionId: "s1",
  title: "t",
  body: "b",
  urgency: "normal",
  tag: "tag-1",
} as unknown as OsNotification;

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

describe("layout wiring (T082)", () => {
  it("RW-01 windows createNotify spawns the toast host from layout().psDir", () => {
    spawnToastHost.mockClear();
    createWinNotify({ exec: stubExec, env });
    expect(spawnToastHost).toHaveBeenCalledWith(path.join(layout().psDir, "toast-host.ps1"));
  });

  it("RW-02 windows focus takes the ps1 directory from layout().psDir", async () => {
    const calls: string[][] = [];
    const exec = async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await selectWtTab({ exec, env } as never, 1);
    const first = calls[0] ?? [];
    const script = first[first.indexOf("-File") + 1];
    expect(script).toBe(path.join(layout().psDir, "wt-tabs.ps1"));
  });

  it("RW-03 linux notify sends layout().iconPath as the app icon", async () => {
    const seen: unknown[][] = [];
    const conn = {
      capabilities: async () => [],
      notify: async (a: unknown[]) => {
        seen.push(a);
        return 1;
      },
      close: async () => undefined,
      onActionInvoked: () => undefined,
      onClosed: () => undefined,
      disconnect: () => undefined,
    };
    const adapter = createNotifyWithConnector({ exec: stubExec, env }, async () => conn as never);
    await adapter.notify(notification, () => undefined);
    expect(seen[0]?.[2]).toBe(layout().iconPath);
  });

  it("RW-04 macos scriptPath resolves under layout().macosScriptsDir", () => {
    expect(scriptPath("ax-list.js")).toBe(path.join(layout().macosScriptsDir, "ax-list.js"));
  });

  it("RW-05 macos osascriptArgs starts with the notify-osascript.applescript file under layout().macosScriptsDir", () => {
    expect(osascriptArgs(notification)[0]).toBe(
      path.join(layout().macosScriptsDir, "notify-osascript.applescript"),
    );
  });

  it("RW-06 macos notify takes mc.js from layout().mcJs", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const exec = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const notifier = createMacNotify({ exec, env } as never);
    expect(notifier.backend).toBe("terminal-notifier");
    await notifier.notify(notification, () => undefined);
    const args = calls[0]?.args ?? [];
    const execCmd = args[args.indexOf("-execute") + 1] ?? "";
    expect(execCmd).toContain(layout().mcJs);
  });

  it("RW-07 no source file under platform/src/windows, linux or macos reads repoRoot", () => {
    for (const dir of ["windows", "linux", "macos"]) {
      for (const file of tsFilesUnder(path.join(PLATFORM_SRC, dir))) {
        expect(readFileSync(file, "utf8"), file).not.toMatch(/\brepoRoot\b/);
      }
    }
  });

  it("RW-08 daemon main.ts has no clone-relative uiDir or package.json version code and uses layout()", async () => {
    const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(src).toContain("@mc/platform/layout");
    expect(src).toContain("lay.uiDir");
    expect(src).toContain("lay.version");
    expect(src).not.toMatch(/"\.\.\/package\.json"/);
    expect(src).not.toMatch(/DAEMON_VERSION/);

    const built = existsSync(path.join(layout().uiDir, "index.html"));
    const home = mkdtempSync(path.join(os.tmpdir(), "mc-rw-"));
    try {
      const d = await startDaemon({
        env: { MC_HOME: home, MC_PLATFORM: "fake", MC_PORT: "0" },
        foreground: false,
      });
      try {
        const res = await fetch("http://127.0.0.1:" + d.port + "/");
        const body = await res.text();
        if (built) {
          expect(res.status).toBe(200);
          expect(body).toMatch(/<html/i);
          expect(body).not.toContain("UI not built");
        } else {
          expect(res.status).toBe(503);
          expect(body).toContain("UI not built");
        }
      } finally {
        await d.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("RW-09 a started daemon reports the root package.json version on /healthz", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "mc-rw-"));
    try {
      const d = await startDaemon({
        env: { MC_HOME: home, MC_PLATFORM: "fake", MC_PORT: "0" },
        foreground: false,
      });
      try {
        const res = await fetch("http://127.0.0.1:" + d.port + "/healthz");
        const json = (await res.json()) as { version: string };
        const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
          version: string;
        };
        expect(json.version).toBe(pkg.version);
      } finally {
        await d.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
