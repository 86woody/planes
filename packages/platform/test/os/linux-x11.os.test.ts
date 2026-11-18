import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IngestOrigin } from "@mc/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { exec } from "../../src/exec.js";
import { createDiscover, parseProcStat } from "../../src/linux/discover.js";
import { createFocus } from "../../src/linux/focus.js";
import type { PlatformEnv, ResolvedTarget } from "../../src/types.js";

// Runs only on Linux inside xvfb-run with openbox, and only when MC_OS_TESTS=1 (AGENTS.md test hygiene).
const enabled = process.platform === "linux" && process.env.MC_OS_TESTS === "1";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8" });
}

function env(): PlatformEnv {
  return {
    stateDir: mkdtempSync(path.join(tmpdir(), "mc-x11-os-")),
    config: {} as PlatformEnv["config"],
    repoRoot: "/nonexistent",
    displayEnv: () => ({ ...process.env }),
  };
}

function origin(pid: number, extra: Record<string, string> = {}): IngestOrigin {
  return {
    os: "linux",
    hookPid: 1,
    agent: null,
    ancestry: [{ pid, name: "xterm" }],
    tty: null,
    env: extra,
    console: null,
  } as unknown as IngestOrigin;
}

/** Polls wmctrl until a window owned by pid appears (xterm maps asynchronously). */
async function waitForWindowId(pid: number): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const line = run("wmctrl", ["-lp"])
      .split("\n")
      .find((l) => l.trim().split(/\s+/)[2] === String(pid));
    if (line !== undefined) return line.trim().split(/\s+/)[0] ?? "";
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no window for pid ${pid}`);
}

function activeId(): number {
  const m = /0x[0-9a-fA-F]+/.exec(run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]));
  return m ? Number(m[0]) : 0;
}

describe.skipIf(!enabled)("linux x11 OS behaviour", () => {
  test("LO-01 a spawned xterm resolves by pid to its wmctrl window id", async () => {
    const title = `MC-TEST-${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn("xterm", ["-T", title, "-e", "sleep", "60"], { stdio: "ignore" });
    children.push(child);
    const id = await waitForWindowId(child.pid ?? 0);
    const d = createDiscover({ exec, env: env() });
    const t = await d.resolveTarget(origin(child.pid ?? 0), {
      kind: "linux-terminal",
      app: "xterm",
      os: "linux",
      display: "x11",
      multiplexer: null,
    });
    expect(t.window?.handle).toBe(id);
    expect(t.capability).toBe("full");
  });

  test("LO-02 minimized xterm: focus(always) -> focused, both maximized atoms, active window", async () => {
    const child = spawn("xterm", ["-T", "MC-TEST-MIN", "-e", "sleep", "60"], { stdio: "ignore" });
    children.push(child);
    const id = await waitForWindowId(child.pid ?? 0);
    run("xdotool", ["windowminimize", id]);
    const e = env();
    const d = createDiscover({ exec, env: e });
    const f = createFocus({ exec, env: e, discover: d });
    const target: ResolvedTarget = {
      window: { os: "linux", handle: id, pid: child.pid ?? 0, app: "xterm", title: "MC-TEST-MIN" },
      inner: null,
      capability: "full",
      reason: null,
    };
    const r = await f.focus(target, { maximize: "always", foregroundStrategy: "plain", fromActivation: false });
    expect(r.status).toBe("ok");
    expect(r.code).toBe("focused");
    const state = run("xprop", ["-id", id, "_NET_WM_STATE"]);
    expect(state).toContain("_NET_WM_STATE_MAXIMIZED_VERT");
    expect(state).toContain("_NET_WM_STATE_MAXIMIZED_HORZ");
    expect(activeId()).toBe(Number(id));
  });

  test("LO-03 focus(never): active, not maximized", async () => {
    const child = spawn("xterm", ["-T", "MC-TEST-NEVER", "-e", "sleep", "60"], { stdio: "ignore" });
    children.push(child);
    const id = await waitForWindowId(child.pid ?? 0);
    const e = env();
    const d = createDiscover({ exec, env: e });
    const f = createFocus({ exec, env: e, discover: d });
    const target: ResolvedTarget = {
      window: { os: "linux", handle: id, pid: child.pid ?? 0, app: "xterm", title: "MC-TEST-NEVER" },
      inner: null,
      capability: "full",
      reason: null,
    };
    const r = await f.focus(target, { maximize: "never", foregroundStrategy: "plain", fromActivation: false });
    expect(r.code).toBe("focused");
    expect(run("xprop", ["-id", id, "_NET_WM_STATE"])).not.toContain("MAXIMIZED_VERT");
    expect(activeId()).toBe(Number(id));
  });

  test("LO-04 killed xterm: not_found", async () => {
    const child = spawn("xterm", ["-T", "MC-TEST-KILL", "-e", "sleep", "60"], { stdio: "ignore" });
    const id = await waitForWindowId(child.pid ?? 0);
    const e = env();
    const d = createDiscover({ exec, env: e });
    const f = createFocus({ exec, env: e, discover: d });
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const target: ResolvedTarget = {
      window: { os: "linux", handle: id, pid: child.pid ?? 0, app: "xterm", title: "MC-TEST-KILL" },
      inner: null,
      capability: "full",
      reason: null,
    };
    const r = await f.focus(target, { maximize: "always", foregroundStrategy: "plain", fromActivation: false });
    expect(r.code).toBe("not_found");
  });

  test("LO-06 tmux inner selector switches the attached client to window two", async () => {
    const sock = path.join(mkdtempSync(path.join(tmpdir(), "mc-tmux-")), "sock");
    run("tmux", ["-S", sock, "new-session", "-d", "-s", "mc", "-n", "one"]);
    run("tmux", ["-S", sock, "new-window", "-d", "-t", "mc", "-n", "two"]);
    const child = spawn("xterm", ["-T", "MC-TEST-TMUX", "-e", "tmux", "-S", sock, "attach", "-t", "mc"], {
      stdio: "ignore",
    });
    children.push(child);
    const id = await waitForWindowId(child.pid ?? 0);
    const pane = run("tmux", ["-S", sock, "display", "-p", "-t", "mc:two", "#{pane_id}"]).trim();
    const e = env();
    const d = createDiscover({ exec, env: e });
    const f = createFocus({ exec, env: e, discover: d });
    const t = await d.resolveTarget(
      origin(child.pid ?? 0, { TMUX: `${sock},1,0`, TMUX_PANE: pane }),
      { kind: "linux-terminal", app: "xterm", os: "linux", display: "x11", multiplexer: null },
    );
    expect(t.inner?.tmuxPane).toBe(pane);
    const r = await f.focus(
      { ...t, window: t.window ?? { os: "linux", handle: id, pid: child.pid ?? 0, app: "xterm", title: "" } },
      { maximize: "never", foregroundStrategy: "plain", fromActivation: false },
    );
    expect(r.code).toBe("focused");
    // tmux numbers windows from 0 and a missing index falls back silently, so match by name.
    expect(run("tmux", ["-S", sock, "display", "-p", "-t", "mc", "#{window_name}"]).trim()).toBe("two");
    run("tmux", ["-S", sock, "kill-server"]);
  });

  test("LO-07 /proc ancestry parsing handles a comm with ') ('", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-comm-"));
    // A script, not a symlink to sleep: multicall coreutils (Ubuntu 26.04) refuses an unknown argv[0].
    const link = path.join(dir, "a) (b");
    writeFileSync(link, "#!/bin/sh\nsleep 30\n");
    chmodSync(link, 0o755);
    const child = spawn(link, [], { stdio: "ignore" });
    children.push(child);
    await new Promise((r) => setTimeout(r, 100));
    const st = parseProcStat(readFileSync(`/proc/${child.pid ?? 0}/stat`, "utf8"));
    expect(st?.comm).toBe("a) (b");
    expect(st?.ppid).toBe(process.pid);
    expect(st?.starttime).toMatch(/^\d+$/);
  });
});
