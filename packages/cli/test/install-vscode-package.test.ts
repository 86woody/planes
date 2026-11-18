import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Layout, layoutFor } from "@mc/platform/layout";
import { afterEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import { REPO, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const sbs: Sandbox[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const sb of sbs.splice(0)) sb.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: Parameters<typeof sandbox>[0] = {}): Sandbox {
  const sb = sandbox(opts);
  sbs.push(sb);
  return sb;
}

/** A package-mode layout over a temp dir; writes the shipped vsix unless told not to. */
function pkgLayout(withVsix = true): Layout {
  const root = mkdtempSync(path.join(tmpdir(), "mc-t086-pkg-"));
  dirs.push(root);
  const lay = layoutFor("package", root, "1.0.0");
  if (withVsix && lay.vsixPath !== null) writeFileSync(lay.vsixPath, "vsix bytes");
  return lay;
}

function cloneLayout(): Layout {
  return layoutFor("clone", REPO, "1.0.0");
}

function vsixOf(lay: Layout): string {
  if (lay.vsixPath === null) throw new Error("layout has no shipped vsix");
  return lay.vsixPath;
}

function manifestOf(sb: Sandbox): Record<string, Record<string, unknown> | undefined> {
  return JSON.parse(readFileSync(path.join(sb.stateDir, "install-manifest.json"), "utf8")) as Record<
    string,
    Record<string, unknown> | undefined
  >;
}

describe("mc install vscode from the shipped vsix (D-43, PACKAGING.md 8)", () => {
  it("VX-01 package mode installs the shipped vsix with code only: no npm, no vsce, no build", async () => {
    const sb = setup({ platform: "win32", onPath: ["code"] });
    const lay = pkgLayout();
    const vsix = vsixOf(lay);
    const code = await install(["vscode"], sb.io, { ...sb.input, layout: lay });
    expect(code).toBe(0);
    expect(sb.calls).toEqual([["code", "--install-extension", vsix]]);
    expect(manifestOf(sb).vscode).toMatchObject({
      installedWith: ["code"],
      extensionId: "woody.vscode-bridge",
      shipped: true,
    });
  });

  it("VX-02 package mode installs into code, code-insiders and cursor in that order, only those on PATH", async () => {
    const lay = pkgLayout();
    const vsix = vsixOf(lay);
    const all = setup({ platform: "win32", onPath: ["cursor", "code", "code-insiders"] });
    expect(await install(["vscode"], all.io, { ...all.input, layout: lay })).toBe(0);
    expect(all.calls).toEqual([
      ["code", "--install-extension", vsix],
      ["code-insiders", "--install-extension", vsix],
      ["cursor", "--install-extension", vsix],
    ]);
    const one = setup({ platform: "win32", onPath: ["code-insiders"] });
    expect(await install(["vscode"], one.io, { ...one.input, layout: lay })).toBe(0);
    expect(one.calls).toEqual([["code-insiders", "--install-extension", vsix]]);
  });

  it("VX-03 package mode with the vsix file missing exits 1 and runs nothing", async () => {
    const sb = setup({ platform: "win32", onPath: ["code"] });
    const lay = pkgLayout(false);
    const code = await install(["vscode"], sb.io, { ...sb.input, layout: lay });
    expect(code).toBe(1);
    expect(sb.calls).toEqual([]);
    expect(sb.errs.join("")).toContain("vscode: packaged extension missing");
  });

  it("VX-04 package mode with no editor on PATH exits 0 and runs nothing", async () => {
    const sb = setup({ platform: "win32", onPath: [] });
    const lay = pkgLayout();
    const code = await install(["vscode"], sb.io, { ...sb.input, layout: lay });
    expect(code).toBe(0);
    expect(sb.calls).toEqual([]);
    expect(sb.out.join("")).toContain("no editor CLI on PATH");
  });

  it("VX-05 package mode uninstall removes the extension from each editor and keeps the shipped vsix file", async () => {
    const sb = setup({ platform: "win32", onPath: ["code"] });
    const lay = pkgLayout();
    const vsix = vsixOf(lay);
    expect(await install(["vscode"], sb.io, { ...sb.input, layout: lay })).toBe(0);
    expect(await uninstall(["vscode"], sb.io, { ...sb.input, layout: lay })).toBe(0);
    expect(sb.calls).toContainEqual(["code", "--uninstall-extension", "woody.vscode-bridge"]);
    expect(existsSync(vsix)).toBe(true);
    expect(manifestOf(sb).vscode).toBeUndefined();
  });

  it("VX-06 clone mode still builds with the vscode-bridge filter and never uses the @mc/ scope", async () => {
    const sb = setup({ platform: "linux", onPath: ["code"] });
    expect(await install(["vscode"], sb.io, { ...sb.input, layout: cloneLayout() })).toBe(0);
    expect(sb.calls[0]).toEqual(["npm", "--prefix", REPO, "-w", "vscode-bridge", "run", "build"]);
    expect(sb.calls.some((c) => c.includes("@mc/vscode-bridge"))).toBe(false);
  });

  it("VX-07 vsce ls lists exactly dist/extension.cjs, package.json and README.md", () => {
    const bridge = path.join(REPO, "packages", "vscode-bridge");
    const shell = process.platform === "win32";
    const build = spawnSync("npm", ["run", "build", "-w", "vscode-bridge"], { cwd: REPO, encoding: "utf8", shell });
    expect(build.status).toBe(0);
    const ls = spawnSync("npx", ["--no", "--", "vsce", "ls", "--no-dependencies"], {
      cwd: bridge,
      encoding: "utf8",
      shell,
      input: "",
    });
    expect(ls.status).toBe(0);
    const files = (ls.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => l.replace(/\\/g, "/"))
      .sort();
    expect(files).toEqual(["README.md", "dist/extension.cjs", "package.json"]);
  }, 60_000);

  it("VX-08 the bridge manifest is named vscode-bridge and main is dist/extension.cjs", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "packages", "vscode-bridge", "package.json"), "utf8")) as {
      name: string;
      main: string;
    };
    expect(pkg.name).toBe("vscode-bridge");
    expect(pkg.main).toBe("./dist/extension.cjs");
  });
});
