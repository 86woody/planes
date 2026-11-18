import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Host, IngestOrigin } from "@mc/contracts";
import { describe, expect, test } from "vitest";
import type { Exec, ExecResult } from "../src/exec.js";
import type { PlatformEnv } from "../src/types.js";
import { selectBackend } from "../src/linux/backends/select.js";
import { parseWmctrl, createX11 } from "../src/linux/backends/x11.js";
import { parseSwayTree, createSway } from "../src/linux/backends/sway.js";
import { parseHyprClients, createHyprland } from "../src/linux/backends/hyprland.js";
import { kwinScript, createKwinBackend } from "../src/linux/backends/kwin.js";
import { parseWindowCalls } from "../src/linux/backends/gnome.js";
import { chooseWindow, createDiscover } from "../src/linux/discover.js";
import { focusTmuxPane, mostRecentClient, parseListClients, tmuxSocket } from "../src/linux/tmux.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/linux/${name}`, import.meta.url)), "utf8");

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail: ExecResult = { code: 1, stdout: "", stderr: "", timedOut: false };

interface Recorded {
  calls: string[][];
}

/** Injected exec: the handler answers by argv, every call is recorded. Nothing real is spawned. */
function fakeExec(handler: (argv: string[]) => ExecResult | undefined): Exec & Recorded {
  const calls: string[][] = [];
  const exec = (async (file: string, args: string[]) => {
    const argv = [file, ...args];
    calls.push(argv);
    return handler(argv) ?? fail;
  }) as Exec & Recorded;
  exec.calls = calls;
  return exec;
}

const host = (display: Host["display"], kind: Host["kind"] = "linux-terminal"): Host => ({
  kind,
  app: null,
  os: "linux",
  display,
  multiplexer: null,
});

function platformEnv(displayEnv: NodeJS.ProcessEnv, config: object = {}): PlatformEnv {
  return {
    stateDir: mkdtempSync(path.join(tmpdir(), "mc-linux-test-")),
    config: config as PlatformEnv["config"],
    repoRoot: "/nonexistent",
    displayEnv: () => displayEnv,
  };
}

function origin(ancestryPids: number[], env: Record<string, string> = {}): IngestOrigin {
  return {
    os: "linux",
    hookPid: 9999,
    agent: null,
    ancestry: ancestryPids.map((pid) => ({ pid, name: "proc" })),
    tty: null,
    env,
    console: null,
  } as unknown as IngestOrigin;
}

describe("linux backends", () => {
  test("LU-01 selectBackend follows the linux.md table order including the config override", () => {
    expect(selectBackend({}, { DISPLAY: ":0" }, { display: "x11" } as Pick<Host, "display">)).toBe("x11");
    expect(selectBackend({}, { SWAYSOCK: "/run/sway" }, null)).toBe("sway");
    expect(selectBackend({}, { HYPRLAND_INSTANCE_SIGNATURE: "abc" }, null)).toBe("hyprland");
    expect(selectBackend({}, { XDG_CURRENT_DESKTOP: "KDE" }, null)).toBe("kwin");
    expect(selectBackend({}, { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, null)).toBe("gnome-extension");
    expect(selectBackend({}, { WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "COSMIC" }, null)).toBe("none");
    // The first match wins: sway beats KDE when both are present.
    expect(selectBackend({}, { SWAYSOCK: "/s", XDG_CURRENT_DESKTOP: "KDE" }, null)).toBe("sway");
    // A config override beats the environment, including "none".
    expect(selectBackend({ linux: { waylandBackend: "none" } }, { SWAYSOCK: "/s" }, null)).toBe("none");
    expect(selectBackend({ linux: { waylandBackend: "kwin" } }, { DISPLAY: ":0" }, null)).toBe("kwin");
    expect(selectBackend({ linux: { waylandBackend: "auto" } }, { SWAYSOCK: "/s" }, null)).toBe("sway");
  });

  test("LU-02 parseWmctrl reads id, desktop, pid, class and titles with spaces", () => {
    const ws = parseWmctrl(fixture("wmctrl-lpx.txt"));
    expect(ws).toHaveLength(5);
    expect(ws[0]).toMatchObject({ id: "0x01e00003", pid: 4321, app: "xterm", title: "MC-TEST shell window" });
    expect(ws[2]).toMatchObject({ id: "0x03a00003", pid: 500, app: "gnome-terminal", title: "bash — project-x" });
    expect(ws[4]?.title).toBe("htop");
  });

  test("LU-03 parseSwayTree finds leaves in nodes and floating_nodes with pid", () => {
    const ws = parseSwayTree(fixture("sway-tree.json"));
    expect(ws.map((w) => [w.id, w.pid])).toEqual([
      ["10", 4321],
      ["11", 4500],
      ["12", 4321],
    ]);
    expect(ws.find((w) => w.focused)?.id).toBe("11");
  });

  test("LU-04 parseHyprClients reads address, pid, fullscreen", () => {
    const ws = parseHyprClients(fixture("hyprctl-clients.json"));
    expect(ws[0]).toMatchObject({ id: "0xabc", pid: 4321, fullscreen: 0 });
    expect(ws[1]).toMatchObject({ id: "0xdef", pid: 4500, fullscreen: 2 });
  });

  test("LU-05 parseWindowCalls reads id, pid, title, focus", () => {
    const ws = parseWindowCalls(fixture("window-calls-list.json"));
    expect(ws[0]).toMatchObject({ id: "101", pid: 4321, title: "project-x", focus: true });
    expect(ws[1]).toMatchObject({ id: "102", pid: 4500, title: "other", focus: false, minimized: true });
  });

  test("LU-06 kwinScript JSON-escapes a caption containing quotes and backslashes", () => {
    const caption = 'say "hi" \\ and </script>';
    const src = kwinScript({ action: "focus", pid: 7, caption, maximize: true });
    expect(src).toContain(JSON.stringify(caption));
    // The raw caption never appears unescaped in the source.
    expect(src).not.toContain('say "hi"');
  });

  test("LU-07 multi-window process: unique project title wins, else topmost, capability window", async () => {
    const windows = parseWmctrl(fixture("wmctrl-lpx.txt"));
    // Without a project hint the topmost window of pid 500 wins (htop, highest stackIndex).
    const stacked = windows.map((w) => ({ ...w, stackIndex: w.stackIndex }));
    expect(chooseWindow(stacked, [500])).toMatchObject({ multi: true, window: { id: "0x03a00020" } });
    // A unique project title wins over stacking.
    expect(chooseWindow(stacked, [500], "project-x")).toMatchObject({ multi: true, window: { id: "0x03a00003" } });
    // A title that matches two windows falls back to topmost.
    expect(chooseWindow(stacked, [500], "bash")).toMatchObject({ window: { id: "0x03a00020" } });

    // Through resolveTarget: several windows, no inner selector -> capability window.
    const exec = fakeExec((argv) => {
      if (argv[0] === "wmctrl") return ok(fixture("wmctrl-lpx.txt"));
      if (argv[0] === "xprop") return ok(fixture("xprop-stacking.txt"));
      return undefined;
    });
    const d = createDiscover({ exec, env: platformEnv({ DISPLAY: ":0" }) });
    const t = await d.resolveTarget(origin([500]), host("x11"));
    expect(t.capability).toBe("window");
    expect(t.reason).toBe("tab_not_addressable");
    expect(t.window?.handle).toBe("0x03a00020");
  });

  test("LU-08 tmux: the most recently active client is chosen and commands use -S socket", async () => {
    const clients = parseListClients(fixture("tmux-list-clients.txt"));
    const client = mostRecentClient(clients);
    expect(client?.tty).toBe("/dev/pts/4");
    expect(client?.session).toBe("main");
    expect(tmuxSocket("/tmp/tmux-1000/default,4321,0")).toBe("/tmp/tmux-1000/default");

    const exec = fakeExec((argv) => (argv[0] === "tmux" ? ok() : undefined));
    const done = await focusTmuxPane(exec, "/tmp/s", "%12", client!);
    expect(done).toBe(true);
    expect(exec.calls).toHaveLength(3);
    for (const argv of exec.calls) {
      expect(argv.slice(0, 3)).toEqual(["tmux", "-S", "/tmp/s"]);
    }
    expect(exec.calls[0]).toEqual(["tmux", "-S", "/tmp/s", "switch-client", "-c", "/dev/pts/4", "-t", "%12"]);
  });

  test("LU-09 unsupported Wayland compositor resolves to none/wayland_unsupported_compositor", async () => {
    const exec = fakeExec(() => undefined);
    const d = createDiscover({
      exec,
      env: platformEnv({ WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "COSMIC" }),
    });
    const t = await d.resolveTarget(origin([100]), host("wayland"));
    expect(t).toEqual({ window: null, inner: null, capability: "none", reason: "wayland_unsupported_compositor" });
    expect(exec.calls).toHaveLength(0);
  });

  test("LU-10 sway maximize is skipped with detail \"tiling: maximize skipped\"; Hyprland maximize only when fullscreen is 0", async () => {
    // sway: a focus command moves focus to the named container; get_tree reflects it.
    const tree = JSON.parse(fixture("sway-tree.json")) as unknown;
    let focused = "11";
    const swayExec = fakeExec((argv) => {
      const m = /^\[con_id=(\d+)\] focus$/.exec(argv[argv.length - 1] ?? "");
      if (m) {
        focused = m[1] ?? focused;
        return ok('[{"success":true}]');
      }
      if (argv.includes("get_tree")) {
        const copy = JSON.parse(JSON.stringify(tree)) as Record<string, unknown>;
        const mark = (n: { id?: number; focused?: boolean; nodes?: unknown[]; floating_nodes?: unknown[] }): void => {
          if (typeof n.id === "number") n.focused = String(n.id) === focused;
          for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) mark(c as typeof n);
        };
        mark(copy as typeof tree & { id: number });
        return ok(JSON.stringify(copy));
      }
      return undefined;
    });
    const sway = createSway({ exec: swayExec });
    const [w10] = parseSwayTree(fixture("sway-tree.json")).filter((w) => w.id === "10");
    const r = await sway.focus(w10!, { maximize: "always", foregroundStrategy: "plain", fromActivation: false });
    expect(r.code).toBe("focused");
    expect(r.detail).toBe("tiling: maximize skipped");
    expect(swayExec.calls.some((c) => c.includes("[con_id=10] focus"))).toBe(true);

    // Hyprland: maximize (dispatch fullscreen 1) only when fullscreen is 0.
    const clients = parseHyprClients(fixture("hyprctl-clients.json"));
    const hyprExec = fakeExec((argv) => {
      if (argv[0] === "hyprctl" && argv[1] === "dispatch") return ok();
      if (argv[0] === "hyprctl" && argv[1] === "activewindow") {
        return ok(JSON.stringify({ address: "0xabc", pid: 4321, title: "project-x", class: "foot", fullscreen: 0 }));
      }
      return undefined;
    });
    const hypr = createHyprland({ exec: hyprExec });
    const opts = { maximize: "always" as const, foregroundStrategy: "plain" as const, fromActivation: false };
    await hypr.focus(clients[0]!, opts);
    expect(hyprExec.calls.some((c) => c.join(" ") === "hyprctl dispatch fullscreen 1")).toBe(true);

    const hyprExec2 = fakeExec((argv) => {
      if (argv[0] === "hyprctl" && argv[1] === "dispatch") return ok();
      if (argv[0] === "hyprctl" && argv[1] === "activewindow") {
        return ok(JSON.stringify({ address: "0xdef", pid: 4500, title: "other", class: "Alacritty", fullscreen: 2 }));
      }
      return undefined;
    });
    const hypr2 = createHyprland({ exec: hyprExec2 });
    const r2 = await hypr2.focus(clients[1]!, opts);
    expect(r2.code).toBe("focused");
    expect(hyprExec2.calls.some((c) => c[1] === "dispatch" && c[2] === "fullscreen")).toBe(false);
  });

  test("LU-10 x11 backend is constructible without touching the real display", () => {
    const x11 = createX11({ exec: fakeExec(() => undefined) });
    expect(typeof x11.focus).toBe("function");
    const kwin = createKwinBackend({ stateDir: platformEnv({}).stateDir, runScript: async () => null });
    expect(typeof kwin.list).toBe("function");
  });
});
