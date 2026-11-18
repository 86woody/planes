import { readFileSync } from "node:fs";
import type { Host, IngestOrigin } from "@mc/contracts";
import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../src/exec.js";
import {
  createDiscover,
  itermUniqueId,
  parseOsascriptError,
  parseTabFind,
  type Discover,
} from "../src/macos/discover.js";
import { createFocus, screenFrame, tmuxInnerCommands, topLeftBounds } from "../src/macos/focus.js";
import type { NativeWindow, PlatformEnv, ResolvedTarget } from "../src/types.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/macos/${name}`, import.meta.url), "utf8");

type Route = (file: string, args: string[]) => Partial<ExecResult> | undefined;

/** Fake exec: routes decide each reply; unmatched calls succeed with empty output. */
function fakeExec(routes: Route[]): { exec: Exec; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args: [...args] });
    for (const route of routes) {
      const hit = route(file, args);
      if (hit !== undefined) return { code: 0, stdout: "", stderr: "", timedOut: false, ...hit };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { exec, calls };
}

const scriptIs = (args: string[], name: string): boolean => args.some((a) => a.endsWith(name));
const env = {} as PlatformEnv;

function origin(opts: { tty?: string | null; env?: Record<string, string> } = {}): IngestOrigin {
  return {
    os: "macos",
    hookPid: 1,
    agent: null,
    ancestry: [] as unknown as IngestOrigin["ancestry"],
    tty: opts.tty === undefined ? "/dev/ttys003" : opts.tty,
    env: (opts.env ?? {}) as IngestOrigin["env"],
    console: { consoleHwnd: null, ownerHwnd: null },
  };
}

function host(kind: Host["kind"], app: string | null): Host {
  return { kind, app, os: "macos", display: "cocoa", multiplexer: null };
}

const stubDiscover: Discover = {
  resolveTarget: async () => ({ window: null, inner: null, capability: "none", reason: "no_window_found" }),
  windowExists: async () => true,
  foregroundWindow: async () => null,
  listWindows: async () => [],
};

describe("macOS discovery and focus", () => {
  it("MU-01 parseOsascriptError classifies -1743, -25211 and other errors", () => {
    expect(parseOsascriptError("execution error: Not authorized to send Apple events. (-1743)")).toBe(
      "automation_denied",
    );
    expect(parseOsascriptError(fixture("ax-focus.stderr-25211.txt"))).toBe("accessibility_denied");
    expect(parseOsascriptError("osascript is not allowed assistive access")).toBe("accessibility_denied");
    expect(parseOsascriptError("syntax error: something (-2741)")).toBe("other");
    expect(parseOsascriptError("")).toBe("other");
  });

  it("MU-02 terminal-find output parses to window id and tab index", () => {
    const tab = parseTabFind(fixture("terminal-find.stdout.json"));
    expect(tab).not.toBeNull();
    expect(tab?.windowId).toBe(5);
    expect(tab?.tab).toBe(2);
    expect(tab?.title).toBe('zsh "main" \\ 1');
    expect(parseTabFind(fixture("find-none.stdout.json"))).toBeNull();
    expect(parseTabFind("not json")).toBeNull();
  });

  it("MU-03 iterm-find falls back to the ITERM_SESSION_ID unique id after the colon", async () => {
    expect(itermUniqueId("w0t0p0:ABC-123")).toBe("ABC-123");
    expect(itermUniqueId("no-colon")).toBe("");
    expect(itermUniqueId(undefined)).toBe("");

    const { exec, calls } = fakeExec([
      (f) => (f === "/usr/bin/pgrep" ? { stdout: "99\n" } : undefined),
      (f, a) => (f === "/usr/bin/osascript" && scriptIs(a, "iterm-find.applescript") ? { stdout: fixture("iterm-find.stdout.json") } : undefined),
    ]);
    const discover = createDiscover({ exec, env });
    const t = await discover.resolveTarget(
      origin({ env: { ITERM_SESSION_ID: "w0t0p0:ABC-123" } }),
      host("iterm2", "iTerm2"),
    );
    const find = calls.find((c) => scriptIs(c.args, "iterm-find.applescript"));
    expect(find?.args.slice(-2)).toEqual(["/dev/ttys003", "ABC-123"]);
    expect(t.capability).toBe("full");
  });

  it("MU-04 screen-frame conversion to top-left bounds for a secondary screen above the primary", async () => {
    // Primary is 900 high; a secondary screen sits above it, so its top-left top is negative.
    const { exec } = fakeExec([
      (f, a) => (scriptIs(a, "screen-frame.js") ? { stdout: fixture("screen-frame.stdout.json") } : undefined),
    ]);
    const b = await screenFrame(exec);
    expect(b).toEqual({ left: 0, top: -1055, right: 1920, bottom: 0 });
    expect(b !== null && b.right > b.left && b.bottom > b.top).toBe(true);
    expect(topLeftBounds({ primaryHeight: 900, x: 0, y: 0, width: 1440, height: 875 })).toEqual({
      left: 0,
      top: 25,
      right: 1440,
      bottom: 900,
    });
  });

  it("MU-05 resolveTarget for Apple_Terminal with a tty is full; without a tty is window", async () => {
    const { exec } = fakeExec([
      (f) => (f === "/usr/bin/pgrep" ? { stdout: "123\n" } : undefined),
      (f, a) => (scriptIs(a, "terminal-find.applescript") ? { stdout: fixture("terminal-find.stdout.json") } : undefined),
    ]);
    const discover = createDiscover({ exec, env });

    const withTty = await discover.resolveTarget(origin({ env: { TERM_PROGRAM: "Apple_Terminal" } }), host("macos-terminal", "Terminal"));
    expect(withTty.capability).toBe("full");
    expect(withTty.inner).toEqual({ tty: "/dev/ttys003" });
    expect(withTty.window?.handle).toBe("Terminal:5");

    const noTty = await discover.resolveTarget(origin({ tty: null, env: { TERM_PROGRAM: "Apple_Terminal" } }), host("macos-terminal", "Terminal"));
    expect(noTty.capability).toBe("window");
    expect(noTty.inner).toBeNull();
  });

  it("MU-06 focus maps automation denied to permission_denied with reason macos_automation_denied", async () => {
    const { exec } = fakeExec([
      (f, a) => (scriptIs(a, "terminal-find.applescript")
        ? { code: 1, stderr: fixture("terminal-find.stderr-1743.txt") }
        : undefined),
    ]);
    const focus = createFocus({ exec, env, discover: stubDiscover });
    const target: ResolvedTarget = {
      window: { os: "macos", handle: "Terminal:5", pid: 123, app: "Terminal", title: "" },
      inner: { tty: "/dev/ttys003" },
      capability: "full",
      reason: null,
    };
    const r = await focus.focus(target, { maximize: "always", foregroundStrategy: "plain", fromActivation: false });
    expect(r.status).toBe("failed");
    expect(r.code).toBe("permission_denied");
    expect(r.detail).toContain("macos_automation_denied");
  });

  it("MU-07 focus never passes raw titles into script source (arguments only)", async () => {
    const hostile = '"); do shell script "touch /tmp/pwned"; --';
    const { exec, calls } = fakeExec([
      (f, a) => (scriptIs(a, "ax-focus.js") ? { stdout: '{"ok":true,"minimized":false}' } : undefined),
    ]);
    const discover: Discover = {
      ...stubDiscover,
      windowExists: async () => true,
      foregroundWindow: async () => ({ os: "macos", handle: "4242:x", pid: 4242, app: "Code", title: hostile }),
    };
    const focus = createFocus({ exec, env, discover });
    const window: NativeWindow = { os: "macos", handle: "4242:x", pid: 4242, app: "Code", title: hostile };
    const r = await focus.focus(
      { window, inner: null, capability: "window", reason: null },
      { maximize: "never", foregroundStrategy: "plain", fromActivation: false },
    );
    expect(r.status).toBe("ok");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.file).toBe("/usr/bin/osascript");
      expect(c.args).not.toContain("-e");
      // The script is a file under the module's scripts directory, and the hostile title is one argv element.
      expect(c.args.some((a) => /[\\/]macos[\\/]scripts[\\/][\w-]+\.(js|applescript)$/.test(a))).toBe(true);
    }
    const axCall = calls.find((c) => scriptIs(c.args, "ax-focus.js"));
    expect(axCall?.args).toContain(hostile);
    expect(calls.every((c) => c.args.every((a) => !a.startsWith("do shell")))).toBe(true);
  });

  it("MU-08 tmux inner selector builds switch-client, select-window, select-pane with -S socket", () => {
    const cmds = tmuxInnerCommands("/tmp/tmux-501/default", "%12", "/dev/ttys003");
    expect(cmds).toEqual([
      ["-S", "/tmp/tmux-501/default", "switch-client", "-c", "/dev/ttys003", "-t", "%12"],
      ["-S", "/tmp/tmux-501/default", "select-window", "-t", "%12"],
      ["-S", "/tmp/tmux-501/default", "select-pane", "-t", "%12"],
    ]);
    expect(tmuxInnerCommands(undefined, "%3", "/dev/ttys001")[0]).toEqual([
      "switch-client", "-c", "/dev/ttys001", "-t", "%3",
    ]);
  });
});
