import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layout, layoutFor } from "../src/layout.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const R = path.resolve(os.tmpdir(), "mc-layout-root");

const CLONE: Record<string, string[]> = {
  mcJs: ["packages", "cli", "dist", "mc.js"],
  daemonJs: ["packages", "daemon", "dist", "bin.js"],
  hookJs: ["packages", "hook", "dist", "mc-hook.js"],
  uiDir: ["packages", "ui", "dist"],
  psDir: ["packages", "platform", "src", "windows", "ps"],
  macosScriptsDir: ["packages", "platform", "dist", "macos", "scripts"],
  iconPath: ["packages", "platform", "assets", "icon-256.png"],
  shellAssetsDir: ["packages", "cli", "assets", "shell"],
  schemasDir: ["packages", "contracts", "schemas"],
};

const PACKAGE: Record<string, string[]> = {
  mcJs: ["dist", "mc.js"],
  daemonJs: ["dist", "daemon.js"],
  hookJs: ["dist", "mc-hook.js"],
  uiDir: ["ui"],
  psDir: ["ps"],
  macosScriptsDir: ["macos-scripts"],
  iconPath: ["assets", "icon-256.png"],
  shellAssetsDir: ["shell"],
  schemasDir: ["schemas"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("layout module", () => {
  it("LY-01 layoutFor clone returns every row of the clone column and vsixPath null", () => {
    const l = layoutFor("clone", R, "9.9.9");
    for (const [field, segments] of Object.entries(CLONE)) {
      expect(l[field as keyof typeof l]).toBe(path.join(R, ...segments));
    }
    expect(l.vsixPath).toBeNull();
    expect(l.root).toBe(path.resolve(R));
  });

  it("LY-02 layoutFor package returns every row of the package column and vsixPath under root", () => {
    const l = layoutFor("package", R, "9.9.9");
    for (const [field, segments] of Object.entries(PACKAGE)) {
      expect(l[field as keyof typeof l]).toBe(path.join(R, ...segments));
    }
    expect(l.vsixPath).toBe(path.join(R, "vscode-bridge.vsix"));
    expect(l.root).toBe(path.resolve(R));
  });

  it("LY-03 layoutFor echoes mode and version and stores root resolved", () => {
    const clone = layoutFor("clone", R, "9.9.9");
    const pkg = layoutFor("package", R, "1.2.3");
    expect(clone.mode).toBe("clone");
    expect(clone.version).toBe("9.9.9");
    expect(pkg.mode).toBe("package");
    expect(pkg.version).toBe("1.2.3");
    expect(path.isAbsolute(layoutFor("clone", "some/relative", "1").root)).toBe(true);
    expect(layoutFor("clone", R + path.sep, "1").root).toBe(path.resolve(R));
  });

  it("LY-04 every path field of both modes is absolute and starts with root", () => {
    for (const mode of ["clone", "package"] as const) {
      const l = layoutFor(mode, R, "1.0.0");
      const paths = [
        l.mcJs,
        l.daemonJs,
        l.hookJs,
        l.uiDir,
        l.psDir,
        l.macosScriptsDir,
        l.iconPath,
        l.shellAssetsDir,
        l.schemasDir,
        l.vsixPath,
      ];
      for (const p of paths) {
        if (p === null) continue;
        expect(path.isAbsolute(p)).toBe(true);
        expect(p.startsWith(l.root)).toBe(true);
      }
    }
  });

  it("LY-05 layout() in the test run is clone mode with root equal to the repo root", () => {
    const l = layout();
    expect(l.mode).toBe("clone");
    expect(l.root).toBe(ROOT);
  });

  it("LY-06 layout().version equals the version in the root package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(layout().version).toBe(pkg.version);
  });

  it("LY-07 layout() is memoised: two calls return the same object", () => {
    expect(layout()).toBe(layout());
  });

  it("LY-08 clone-mode source files exist: the three ps1 files, the icon, the three shell snippets, a schema and a macOS script", () => {
    const l = layout();
    expect(existsSync(path.join(l.psDir, "toast-host.ps1"))).toBe(true);
    expect(existsSync(path.join(l.psDir, "wt-tabs.ps1"))).toBe(true);
    expect(existsSync(path.join(l.psDir, "wt-select-tab.ps1"))).toBe(true);
    expect(existsSync(l.iconPath)).toBe(true);
    expect(existsSync(path.join(l.shellAssetsDir, "mc.ps1"))).toBe(true);
    expect(existsSync(path.join(l.shellAssetsDir, "mc.bash"))).toBe(true);
    expect(existsSync(path.join(l.shellAssetsDir, "mc.zsh"))).toBe(true);
    expect(existsSync(path.join(l.schemasDir, "api.schema.json"))).toBe(true);
    expect(existsSync(path.join(l.macosScriptsDir, "notify-osascript.applescript"))).toBe(true);
  });

  it("LY-09 clone-mode built files exist: mc.js, bin.js, mc-hook.js and the UI index.html", () => {
    const l = layout();
    expect(existsSync(l.mcJs)).toBe(true);
    expect(existsSync(l.daemonJs)).toBe(true);
    expect(existsSync(l.hookJs)).toBe(true);
    expect(existsSync(path.join(l.uiDir, "index.html"))).toBe(true);
  });

  it("LY-10 with __MC_PACKAGE__ stubbed, a fresh layout() is package mode rooted at the module parent with that version", async () => {
    vi.stubGlobal("__MC_PACKAGE__", { version: "7.7.7" });
    vi.resetModules();
    const m = await import("../src/layout.js");
    const l = m.layout();
    const root = path.resolve(HERE, "..");
    expect(l.mode).toBe("package");
    expect(l.version).toBe("7.7.7");
    expect(l.root).toBe(root);
    expect(l.mcJs).toBe(path.join(root, "dist", "mc.js"));
  });

  it("LY-11 layout.ts imports only node: builtins", () => {
    const src = readFileSync(path.join(HERE, "../src/layout.ts"), "utf8");
    const specs = [
      ...[...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
    ];
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec?.startsWith("node:")).toBe(true);
    }
  });

  it("LY-12 the build emits dist/layout.js and dist/layout.d.ts", () => {
    const dist = path.join(ROOT, "packages", "platform", "dist");
    expect(existsSync(path.join(dist, "layout.js"))).toBe(true);
    expect(existsSync(path.join(dist, "layout.d.ts"))).toBe(true);
  });
});
