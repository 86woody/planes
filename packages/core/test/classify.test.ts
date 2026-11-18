import { describe, expect, it } from "vitest";
import { validateSession, type Host, type IngestOrigin, type ProcessInfo, type Session } from "@mc/contracts";
import { classifyHost } from "../src/classify.js";
import { CallsignAllocator } from "../src/callsign.js";

type Env = IngestOrigin["env"];

const proc = (pid: number, name: string): ProcessInfo => ({ pid, name, startTime: String(pid) });

function origin(o: {
  os?: IngestOrigin["os"];
  env?: Env;
  ancestry?: ProcessInfo[];
  consoleHwnd?: string | null;
}): IngestOrigin {
  const ancestry = o.ancestry ?? [];
  const agent = ancestry.find((p) => p.name.toLowerCase().replace(/\.exe$/, "") === "claude") ?? null;
  return {
    os: o.os ?? "windows",
    hookPid: 9999,
    agent,
    ancestry: ancestry as IngestOrigin["ancestry"],
    tty: null,
    env: o.env ?? {},
    console: { consoleHwnd: o.consoleHwnd ?? null, ownerHwnd: null },
  } as IngestOrigin;
}

const claude = proc(100, "claude.exe");
const pwsh = proc(101, "pwsh.exe");
const bash = proc(102, "bash");

const fixtureSession = (host: Host): Session =>
  ({
    id: "claude-code:fixture-1",
    adapter: "claude-code",
    nativeId: "fixture-1",
    callsign: "MC-01",
    title: "fixture",
    cwd: "C:\\work\\repo",
    project: "repo",
    branch: null,
    state: "idle",
    attention: { active: false, reason: null, since: null, acknowledged: false, message: null },
    startedAt: "2026-11-08T20:15:03.120Z",
    updatedAt: "2026-11-08T20:15:03.120Z",
    lastEvent: { name: "Stop", at: "2026-11-08T20:15:03.120Z", summary: "Idle" },
    process: { agentPid: 100, alive: true },
    host,
    restore: { capability: "none", reason: "no_window_found", lastResult: null },
    stats: { prompts: 0, tools: 0, notifications: 0, events: 0 },
    endReason: null,
  }) as Session;

describe("host classification and callsigns", () => {
  it("CL-01 SSH_CONNECTION -> remote", () => {
    const h = classifyHost(origin({ os: "linux", env: { SSH_CONNECTION: "present" }, ancestry: [claude] }));
    expect(h.kind).toBe("remote");
    expect(h.app).toBeNull();
  });

  it("CL-02 CLAUDE_CODE_ENTRYPOINT claude-vscode -> vscode-extension", () => {
    const h = classifyHost(origin({ env: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, ancestry: [claude] }));
    expect(h.kind).toBe("vscode-extension");
  });

  it("CL-03 Code.exe ancestor with no shell between -> vscode-extension", () => {
    const h = classifyHost(origin({ ancestry: [claude, proc(103, "Code.exe")] }));
    expect(h.kind).toBe("vscode-extension");
    expect(h.app).toBe("Code.exe");
  });

  it("CL-04 TERM_PROGRAM vscode with pwsh between -> vscode-terminal", () => {
    const h = classifyHost(
      origin({ env: { TERM_PROGRAM: "vscode" }, ancestry: [claude, pwsh, proc(103, "Code.exe")] }),
    );
    expect(h.kind).toBe("vscode-terminal");
    expect(h.app).toBe("Code.exe");
  });

  it("CL-05 WT_SESSION -> windows-terminal, app WindowsTerminal.exe", () => {
    const h = classifyHost(
      origin({ env: { WT_SESSION: "abc" }, ancestry: [claude, pwsh, proc(104, "WindowsTerminal.exe")] }),
    );
    expect(h.kind).toBe("windows-terminal");
    expect(h.app).toBe("WindowsTerminal.exe");
  });

  it("CL-06 windows with consoleHwnd and no WT -> conhost", () => {
    const h = classifyHost(origin({ consoleHwnd: "0x00000000001A0B2C", ancestry: [claude, pwsh] }));
    expect(h.kind).toBe("conhost");
    expect(h.app).toBe("conhost.exe");
  });

  it("CL-07 Apple_Terminal -> macos-terminal", () => {
    const h = classifyHost(origin({ os: "macos", env: { TERM_PROGRAM: "Apple_Terminal" }, ancestry: [claude] }));
    expect(h.kind).toBe("macos-terminal");
    expect(h.app).toBe("Terminal");
  });

  it("CL-08 ITERM_SESSION_ID -> iterm2", () => {
    const h = classifyHost(origin({ os: "macos", env: { ITERM_SESSION_ID: "w0t0p0" }, ancestry: [claude] }));
    expect(h.kind).toBe("iterm2");
    expect(h.app).toBe("iTerm2");
  });

  it("CL-09 WEZTERM_PANE -> wezterm", () => {
    const h = classifyHost(origin({ os: "linux", env: { WEZTERM_PANE: "0" }, ancestry: [claude] }));
    expect(h.kind).toBe("wezterm");
    expect(h.app).toBe("wezterm-gui");
  });

  it("CL-10 KITTY_WINDOW_ID -> kitty", () => {
    const h = classifyHost(origin({ os: "linux", env: { KITTY_WINDOW_ID: "1" }, ancestry: [claude] }));
    expect(h.kind).toBe("kitty");
    expect(h.app).toBe("kitty");
  });

  it("CL-11 linux ancestry gnome-terminal-server -> linux-terminal with app name", () => {
    const h = classifyHost(
      origin({ os: "linux", ancestry: [claude, bash, proc(105, "gnome-terminal-server")] }),
    );
    expect(h.kind).toBe("linux-terminal");
    expect(h.app).toBe("gnome-terminal-server");
  });

  it("CL-12 nothing matches -> unknown", () => {
    const h = classifyHost(origin({ os: "linux", ancestry: [claude, bash] }));
    expect(h.kind).toBe("unknown");
    expect(h.app).toBeNull();
  });

  it("CL-13 TMUX + TMUX_PANE -> multiplexer tmux %3, kind unchanged", () => {
    const h = classifyHost(
      origin({
        os: "linux",
        env: { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%3" },
        ancestry: [claude, bash, proc(105, "gnome-terminal-server")],
      }),
    );
    expect(h.multiplexer).toEqual({ kind: "tmux", pane: "%3" });
    expect(h.kind).toBe("linux-terminal");
  });

  it("CL-14 display: WAYLAND_DISPLAY beats DISPLAY; windows -> win32; macos -> cocoa", () => {
    const both: Env = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
    expect(classifyHost(origin({ os: "linux", env: both, ancestry: [claude] })).display).toBe("wayland");
    expect(classifyHost(origin({ os: "linux", env: { DISPLAY: ":0" }, ancestry: [claude] })).display).toBe("x11");
    expect(classifyHost(origin({ os: "linux", ancestry: [claude] })).display).toBeNull();
    expect(classifyHost(origin({ os: "windows", env: both, ancestry: [claude] })).display).toBe("win32");
    expect(classifyHost(origin({ os: "macos", env: both, ancestry: [claude] })).display).toBe("cocoa");
  });

  it("CL-15 callsigns run MC-01..MC-99 then wrap and skip in-use values", () => {
    const fresh = new CallsignAllocator(0, () => new Set());
    const seen: string[] = [];
    for (let i = 0; i < 99; i++) seen.push(fresh.next());
    expect(seen[0]).toBe("MC-01");
    expect(seen[98]).toBe("MC-99");
    expect(fresh.counter()).toBe(99);
    expect(fresh.next()).toBe("MC-01");

    const skipping = new CallsignAllocator(0, () => new Set(["MC-01", "MC-02"]));
    expect(skipping.next()).toBe("MC-03");

    const allUsed = new Set(Array.from({ length: 99 }, (_, i) => `MC-${String(i + 1).padStart(2, "0")}`));
    const full = new CallsignAllocator(5, () => allUsed);
    expect(full.next()).toBe("MC-06");
  });

  it("CL-16 every classifyHost result validates as session.schema.json Host", () => {
    const origins: IngestOrigin[] = [
      origin({ env: { SSH_CONNECTION: "present" }, ancestry: [claude] }),
      origin({ ancestry: [claude, proc(103, "Code.exe")] }),
      origin({ env: { WT_SESSION: "x", TMUX: "t", TMUX_PANE: "%3" }, ancestry: [claude] }),
      origin({ consoleHwnd: "0x00000000001A0B2C", ancestry: [claude] }),
      origin({ os: "macos", env: { TERM_PROGRAM: "Apple_Terminal" }, ancestry: [claude] }),
      origin({ os: "linux", env: { WAYLAND_DISPLAY: "w" }, ancestry: [claude, proc(105, "gnome-terminal-server")] }),
      origin({ os: "linux", ancestry: [claude] }),
    ];
    for (const o of origins) {
      const host = classifyHost(o);
      const result = validateSession(fixtureSession(host));
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  });
});

describe("conhost started inside Windows Terminal (T103, D-50)", () => {
  it("CL-17 a conhost nearer than WT wins over WT_SESSION; a plain WT tab is unchanged", () => {
    const nested = classifyHost(
      origin({
        env: { WT_SESSION: "abc" },
        consoleHwnd: "0x000000000B091150",
        ancestry: [claude, pwsh, proc(105, "conhost.exe"), proc(106, "pwsh.exe"), proc(104, "WindowsTerminal.exe")],
      }),
    );
    expect(nested.kind).toBe("conhost");
    expect(nested.app).toBe("conhost.exe");

    const noHwnd = classifyHost(
      origin({ env: { WT_SESSION: "abc" }, ancestry: [claude, pwsh, proc(105, "conhost.exe"), proc(104, "WindowsTerminal.exe")] }),
    );
    expect(noHwnd.kind).toBe("conhost");

    const tab = classifyHost(
      origin({ env: { WT_SESSION: "abc" }, consoleHwnd: "0x0000000000ABCDEF", ancestry: [claude, pwsh, proc(104, "WindowsTerminal.exe")] }),
    );
    expect(tab.kind).toBe("windows-terminal");
  });
});
