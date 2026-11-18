// OS tests for windows/focus.ts. Run only with MC_OS_TESTS=1 on an interactive desktop.
// Every window acted on here is spawned by this file (MC-TEST-<rand> title); no other window is touched.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exec, which } from "../../src/exec.js";
import type { Discover } from "../../src/windows/discover.js";
import {
  createFocus,
  formatHandle,
  loadWin32Focus,
  SW_MINIMIZE,
} from "../../src/windows/focus.js";
import type { FocusOptions, NativeWindow, PlatformEnv, ResolvedTarget } from "../../src/types.js";

const osIt = process.env.MC_OS_TESTS === "1" ? it : it.skip;
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const TABS_SCRIPT = path.join(REPO_ROOT, "packages", "platform", "src", "windows", "ps", "wt-tabs.ps1");
const PS_BASE = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

// Only PIDs this file started; cleanup never touches anything else.
const spawnedPids: number[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined);
  for (const pid of spawnedPids.splice(0)) {
    await exec("taskkill", ["/pid", String(pid), "/T", "/F"]);
  }
});

const randTitle = (): string => `MC-TEST-${randomBytes(4).toString("hex")}`;

async function ps(script: string, timeoutMs = 10_000): Promise<string> {
  const r = await exec("powershell.exe", [...PS_BASE, "-Command", script], { timeoutMs });
  return r.stdout.trim();
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface Spawned {
  hwnd: number;
  pid: number;
  win: NativeWindow;
}

/** Top-level window whose name contains `title`, via UI Automation (Get-Process reports 0 for conhost). */
async function findWindowByTitle(title: string): Promise<number | null> {
  const h = Number(
    await ps(
      `Add-Type -AssemblyName UIAutomationClient; $root=[System.Windows.Automation.AutomationElement]::RootElement; ` +
        `foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)){ ` +
        `if($e.Current.Name -like '*${title}*'){ [string]$e.Current.NativeWindowHandle; break } }`,
    ),
  );
  return h > 0 ? h : null;
}

/** A classic console window started by this test. */
async function spawnConhost(): Promise<Spawned> {
  // Started through PowerShell: conhost.exe launched straight from node exits at once here.
  const title = randTitle();
  const started = Number(
    await ps(
      `(Start-Process conhost.exe -ArgumentList 'cmd.exe','/k','title ${title}' -PassThru).Id`,
    ),
  );
  if (!(started > 0)) throw new Error("conhost.exe did not start");
  spawnedPids.push(started);
  const hwnd = await waitFor(() => findWindowByTitle(title), 10_000);
  const owner = [0];
  loadWin32Focus().GetWindowThreadProcessId(hwnd, owner);
  const pid = owner[0] || started;
  return {
    hwnd,
    pid,
    win: { os: "windows", handle: formatHandle(hwnd), pid, app: "conhost.exe", title },
  };
}

const focusDeps = { exec, env: {} as PlatformEnv, discover: {} as Discover };
const focus = createFocus(focusDeps);
const target = (win: NativeWindow, inner: ResolvedTarget["inner"] = null): ResolvedTarget => ({
  window: win,
  inner,
  capability: "full",
  reason: null,
});
const opts = (maximize: FocusOptions["maximize"]): FocusOptions => ({
  maximize,
  foregroundStrategy: "alt-key",
  fromActivation: false,
});

describe("windows focus (OS)", () => {
  osIt("WO-02 minimized conhost window: focus(always) -> focused, zoomed, foreground", async () => {
    const s = await spawnConhost();
    const w = loadWin32Focus();
    w.ShowWindow(s.hwnd, SW_MINIMIZE);
    const r = await focus.focus(target(s.win), opts("always"));
    expect(r.code).toBe("focused");
    expect(w.IsZoomed(s.hwnd)).toBe(true);
    expect(w.GetForegroundWindow()).toBe(s.hwnd);
  }, 30_000);

  osIt("WO-03 focus(never) on a minimized window: foreground, not zoomed", async () => {
    const s = await spawnConhost();
    const w = loadWin32Focus();
    w.ShowWindow(s.hwnd, SW_MINIMIZE);
    const r = await focus.focus(target(s.win), opts("never"));
    expect(r.code).toBe("focused");
    expect(w.IsZoomed(s.hwnd)).toBe(false);
    expect(w.GetForegroundWindow()).toBe(s.hwnd);
  }, 30_000);

  osIt("WO-04 closed window: not_found", async () => {
    const s = await spawnConhost();
    const w = loadWin32Focus();
    await exec("taskkill", ["/pid", String(s.pid), "/T", "/F"]);
    await waitFor(async () => (w.IsWindow(s.hwnd) ? null : true), 5_000);
    const r = await focus.focus(target(s.win), opts("always"));
    expect(r.status).toBe("failed");
    expect(r.code).toBe("not_found");
  }, 30_000);

  osIt("WO-07 Windows Terminal window with one tab: focused", async () => {
    const wt = await which("wt.exe");
    if (wt === null) {
      expect(wt).toBeNull();
      return;
    }
    const title = randTitle();
    // wt.exe is a launcher; its window lives in WindowsTerminal.exe, so cleanup closes the window by title.
    spawn(wt, ["-w", "new", "--title", title, "cmd", "/k"], { stdio: "ignore" }).unref();
    cleanups.push(() =>
      ps(
        `Add-Type -AssemblyName UIAutomationClient; $root=[System.Windows.Automation.AutomationElement]::RootElement; ` +
          `foreach($e in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)){ ` +
          `if($e.Current.Name -like '*${title}*'){ $e.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close(); break } }`,
      ),
    );

    const hwnd = await waitFor(() => findWindowByTitle(title), 20_000);

    const owner = [0];
    const w = loadWin32Focus();
    w.GetWindowThreadProcessId(hwnd, owner);
    const win: NativeWindow = {
      os: "windows",
      handle: formatHandle(hwnd),
      pid: owner[0] ?? 0,
      app: "WindowsTerminal.exe",
      title,
    };

    const tabsRun = await exec("powershell.exe", [...PS_BASE, "-File", TABS_SCRIPT, String(hwnd)], {
      timeoutMs: 10_000,
    });
    const tabs = JSON.parse(tabsRun.stdout) as Array<{ index: number; name: string }>;
    expect(tabs).toHaveLength(1);

    const wtFocus = createFocus({ exec, env: { repoRoot: REPO_ROOT } as PlatformEnv, discover: focusDeps.discover });
    const r = await wtFocus.focus(target(win, { wtTabTitle: tabs[0]?.name ?? "" }), opts("always"));
    expect(r.code).toBe("focused");
  }, 60_000);
});
