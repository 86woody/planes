import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseWindow } from "../src/windows/discover.js";
import type { WindowInfo } from "../src/windows/win32.js";

interface Fixture {
  origin: Parameters<typeof chooseWindow>[0]["origin"];
  host: Parameters<typeof chooseWindow>[0]["host"];
  windows: WindowInfo[];
  lookup: WindowInfo[];
}

function load(name: string): Fixture {
  const url = new URL(`./fixtures/windows/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Fixture;
}

function run(name: string) {
  const fx = load(name);
  const all = [...fx.windows, ...fx.lookup];
  return chooseWindow({
    origin: fx.origin,
    host: fx.host,
    windows: fx.windows,
    byHwnd: (hex) => all.find((w) => w.hwnd === hex.slice(0, 2) + hex.slice(2).toUpperCase()),
  });
}

describe("windows discovery (windows.md 2)", () => {
  it("WU-01 conhost: ConsoleWindowClass consoleHwnd is chosen, capability full", () => {
    const t = run("conhost");
    expect(t.window?.handle).toBe("0x00000000000A1B2C");
    expect(t.window?.app).toBe("conhost.exe");
    expect(t.capability).toBe("full");
    expect(t.inner).toBeNull();
    expect(t.reason).toBeNull();
  });

  it("WU-02 ownerHwnd owned by WindowsTerminal.exe is chosen with wtTabTitle", () => {
    const t = run("wt-owner");
    expect(t.window?.handle).toBe("0x0000000000000C01");
    expect(t.window?.app).toBe("WindowsTerminal.exe");
    expect(t.capability).toBe("full");
    expect(t.inner).toEqual({ wtTabTitle: "Claude Code - api" });
  });

  it("WU-03 PseudoConsoleWindow consoleHwnd resolves through its root owner", () => {
    const t = run("wt-pseudoconsole");
    expect(t.window?.handle).toBe("0x0000000000000C01");
    expect(t.capability).toBe("full");
    expect(t.inner).toEqual({ wtTabTitle: "Claude Code - api" });
  });

  it('WU-04 two WT windows and no ownerHwnd -> none/no_window_found "ambiguous: 2 windows"', () => {
    const t = run("wt-two-windows");
    expect(t.window).toBeNull();
    expect(t.capability).toBe("none");
    expect(t.reason).toBe("no_window_found");
  });

  it("WU-05 unknown host takes the first ancestor with a visible unowned titled window, capability window", () => {
    const t = run("unknown-host");
    expect(t.window?.handle).toBe("0x0000000000000D02");
    expect(t.window?.pid).toBe(6000);
    expect(t.capability).toBe("window");
    expect(t.inner).toBeNull();
  });

  it("WU-06 elevated owner -> none/target_elevated (D-49) and WSL origin with one WT window -> window", () => {
    const elevated = run("elevated-wt");
    expect(elevated.window).toBeNull();
    expect(elevated.capability).toBe("none");
    expect(elevated.reason).toBe("target_elevated");

    const wsl = run("wsl-wt");
    expect(wsl.window?.handle).toBe("0x0000000000000E01");
    expect(wsl.capability).toBe("window");
    expect(wsl.inner).toBeNull();
  });
});

describe("chooseWindow edge rules", () => {
  it("a remote host resolves to none/remote_session without looking at windows", () => {
    const fx = load("conhost");
    const t = chooseWindow({
      origin: fx.origin,
      host: { ...fx.host, kind: "remote" } as Fixture["host"],
      windows: [],
      byHwnd: () => undefined,
    });
    expect(t.capability).toBe("none");
    expect(t.reason).toBe("remote_session");
  });

  it("EL-02 a WSL origin whose only Windows Terminal window is elevated resolves to none/target_elevated", () => {
    const fx = load("wsl-wt");
    const all = [...fx.windows, ...fx.lookup].map((w) => ({ ...w, elevated: true }));
    const t = chooseWindow({
      origin: fx.origin,
      host: fx.host,
      windows: fx.windows.map((w) => ({ ...w, elevated: true })),
      byHwnd: (h) => all.find((w) => w.hwnd === h),
    });
    expect(t.window).toBeNull();
    expect(t.capability).toBe("none");
    expect(t.reason).toBe("target_elevated");
  });
});
