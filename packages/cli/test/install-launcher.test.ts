import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Layout, layoutFor } from "@mc/platform/layout";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { launcherPaths, launcherText, readLauncherTarget, writeLaunchers } from "../src/installers/launcher.js";
import { fwd, hookJsPath, makeCtx, mcJsPath, prepareLaunchers } from "../src/installers/manifest.js";
import { LAYOUT, NODE, REPO, launcherHook, launcherMc, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

let tmp: string;
const made: Sandbox[] = [];
const sandboxed = (opts?: Parameters<typeof sandbox>[0]): Sandbox => {
  const s = sandbox(opts);
  made.push(s);
  return s;
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "mc-ln-"));
});
afterEach(() => {
  for (const s of made.splice(0)) s.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

describe("launchers", () => {
  it("LN-01 launcherPaths puts mc-hook.js and mc.js in <stateDir>/bin", () => {
    expect(launcherPaths("/s")).toEqual({
      dir: path.join("/s", "bin"),
      hookJs: path.join("/s", "bin", "mc-hook.js"),
      mcJs: path.join("/s", "bin", "mc.js"),
    });
  });

  it("LN-02 launcherText hook is the two-line text of PACKAGING.md 4 with exit 0", () => {
    const t = path.resolve(tmp, "dist", "mc-hook.js");
    expect(launcherText("hook", t, "1.2.3")).toBe(
      "// mission-control launcher. target: " +
        t +
        ". version: 1.2.3\n" +
        "import(" +
        JSON.stringify(pathToFileURL(t).href) +
        ').catch((e) => { process.stderr.write(String(e && e.stack || e) + "\\n"); process.exit(0); });\n',
    );
  });

  it("LN-03 launcherText mc is the same text with exit 1", () => {
    const t = path.resolve(tmp, "dist", "mc.js");
    expect(launcherText("mc", t, "1.2.3")).toBe(
      "// mission-control launcher. target: " +
        t +
        ". version: 1.2.3\n" +
        "import(" +
        JSON.stringify(pathToFileURL(t).href) +
        ').catch((e) => { process.stderr.write(String(e && e.stack || e) + "\\n"); process.exit(1); });\n',
    );
  });

  it("LN-04 writeLaunchers writes package.json {\"type\":\"commonjs\"}, both launchers, and reports changed once", () => {
    const stateDir = path.join(tmp, "state");
    const lay = layoutFor("package", tmp, "1.0.0");
    expect(writeLaunchers(stateDir, lay)).toEqual({ changed: true });
    const bin = launcherPaths(stateDir);
    expect(readFileSync(path.join(bin.dir, "package.json"), "utf8")).toBe('{"type":"commonjs"}\n');
    expect(readFileSync(bin.hookJs, "utf8")).toBe(launcherText("hook", lay.hookJs, "1.0.0"));
    expect(readFileSync(bin.mcJs, "utf8")).toBe(launcherText("mc", lay.mcJs, "1.0.0"));
    const before = [readFileSync(bin.hookJs, "utf8"), readFileSync(bin.mcJs, "utf8")];
    expect(writeLaunchers(stateDir, lay)).toEqual({ changed: false });
    expect([readFileSync(bin.hookJs, "utf8"), readFileSync(bin.mcJs, "utf8")]).toEqual(before);
  });

  it("LN-05 writeLaunchers rewrites both launchers and reports changed when the layout moves", () => {
    const stateDir = path.join(tmp, "state");
    writeLaunchers(stateDir, layoutFor("package", tmp, "1.0.0"));
    const movedRoot = path.join(tmp, "moved");
    const moved = layoutFor("package", movedRoot, "1.0.1");
    expect(writeLaunchers(stateDir, moved)).toEqual({ changed: true });
    expect(readLauncherTarget(launcherPaths(stateDir).hookJs)).toBe(moved.hookJs);
    expect(readLauncherTarget(launcherPaths(stateDir).mcJs)).toBe(moved.mcJs);
    expect(writeLaunchers(stateDir, layoutFor("package", movedRoot, "1.0.2"))).toEqual({ changed: false });
    expect(readFileSync(launcherPaths(stateDir).hookJs, "utf8").split("\n")[0]).toContain("version: 1.0.2");
  });

  it("LN-06 readLauncherTarget returns the target, and null for a missing file or a file that is not a launcher", () => {
    const stateDir = path.join(tmp, "state");
    const lay = layoutFor("package", tmp, "1");
    writeLaunchers(stateDir, lay);
    expect(readLauncherTarget(launcherPaths(stateDir).hookJs)).toBe(lay.hookJs);
    expect(readLauncherTarget(path.join(tmp, "no", "such", "file.js"))).toBeNull();
    const plain = path.join(tmp, "plain.js");
    writeFileSync(plain, "hello\n");
    expect(readLauncherTarget(plain)).toBeNull();
    const spaced = path.join(tmp, "a b", "x.js");
    const stateDir2 = path.join(tmp, "state2");
    const spacedLay: Layout = { ...lay, hookJs: spaced };
    writeLaunchers(stateDir2, spacedLay);
    expect(readLauncherTarget(launcherPaths(stateDir2).hookJs)).toBe(spaced);
  });

  it("LN-07 node <launcher> imports the target file and passes the arguments", () => {
    const target = path.join(tmp, "target.mjs");
    writeFileSync(target, 'process.stdout.write("LN-TARGET-RAN " + process.argv.slice(2).join(" ") + "\\n");\n');
    const stateDir = path.join(tmp, "state");
    writeLaunchers(stateDir, { ...layoutFor("package", tmp, "1"), hookJs: target, mcJs: target });
    const h = spawnSync(process.execPath, [launcherPaths(stateDir).hookJs, "claude-code"], { encoding: "utf8" });
    expect(h.status).toBe(0);
    expect(h.stdout).toBe("LN-TARGET-RAN claude-code\n");
    const m = spawnSync(process.execPath, [launcherPaths(stateDir).mcJs, "status", "--x"], { encoding: "utf8" });
    expect(m.status).toBe(0);
    expect(m.stdout).toBe("LN-TARGET-RAN status --x\n");
  });

  it("LN-08 a launcher whose target is missing prints the error and exits 0 for hook, 1 for mc", () => {
    const nope = path.join(tmp, "nope.mjs");
    const stateDir = path.join(tmp, "state");
    writeLaunchers(stateDir, { ...layoutFor("package", tmp, "1"), hookJs: nope, mcJs: nope });
    const h = spawnSync(process.execPath, [launcherPaths(stateDir).hookJs], { encoding: "utf8" });
    expect(h.status).toBe(0);
    expect(h.stderr).toContain("nope.mjs");
    const m = spawnSync(process.execPath, [launcherPaths(stateDir).mcJs], { encoding: "utf8" });
    expect(m.status).toBe(1);
    expect(m.stderr).toContain("nope.mjs");
  });

  it("LN-09 makeCtx takes layout() by default and hookJsPath and mcJsPath return the launcher paths", () => {
    const sb = sandboxed();
    const rest = { ...sb.input };
    delete rest.layout;
    const ctx = makeCtx(sb.io, rest);
    expect(ctx.layout.mode).toBe("clone");
    expect(ctx.layout.root).toBe(REPO);
    expect(ctx.repo).toBe(REPO);
    expect(hookJsPath(ctx)).toBe(launcherPaths(sb.stateDir).hookJs);
    expect(mcJsPath(ctx)).toBe(launcherPaths(sb.stateDir).mcJs);
    expect(makeCtx(sb.io, sb.input).layout).toBe(LAYOUT);
  });

  it("LN-10 shell install writes the launchers, points shell.env at the hook launcher and reads the snippet from layout().shellAssetsDir", async () => {
    const sb = sandboxed();
    const tmpAssets = path.join(tmp, "assets");
    mkdirSync(tmpAssets, { recursive: true });
    writeFileSync(path.join(tmpAssets, "mc.bash"), "# custom __MC_STATE_DIR__\n");
    sb.input.layout = { ...LAYOUT, shellAssetsDir: tmpAssets };
    expect(await install(["shell", "--bash"], sb.io, sb.input)).toBe(0);
    const snippet = readFileSync(path.join(sb.stateDir, "shell", "mc.bash"), "utf8");
    expect(snippet).toContain("# custom");
    expect(snippet).not.toContain("__MC_STATE_DIR__");
    expect(readLauncherTarget(launcherPaths(sb.stateDir).hookJs)).toBe(LAYOUT.hookJs);
    expect(readFileSync(path.join(sb.stateDir, "shell.env"), "utf8")).toBe(
      `MC_NODE=${fwd(NODE)}\nMC_HOOK_JS=${launcherHook(sb)}\nMC_OTEL_DIR=${fwd(sb.stateDir)}/otel\n`,
    );
  });

  it("LN-11 uri-handler on windows registers layout().iconPath and a restore.vbs that runs the mc launcher", async () => {
    const win = sandboxed({ platform: "win32" });
    expect(await install(["uri-handler"], win.io, win.input)).toBe(0);
    expect(win.calls).toContainEqual([
      "reg.exe",
      "add",
      "HKCU\\Software\\Classes\\AppUserModelId\\WoodyDeus.MissionControl",
      "/v",
      "IconUri",
      "/t",
      "REG_SZ",
      "/d",
      LAYOUT.iconPath,
      "/f",
    ]);
    const vbs = readFileSync(path.join(win.stateDir, "restore.vbs"), "utf8");
    expect(vbs).toContain(`"${path.join(win.stateDir, "bin", "mc.js")}"`);
    expect(readLauncherTarget(launcherPaths(win.stateDir).mcJs)).toBe(LAYOUT.mcJs);
  });

  it("LN-12 uri-handler on linux and autostart on all three OSes name the mc launcher and write it", async () => {
    const lin = sandboxed({ platform: "linux" });
    expect(await install(["uri-handler"], lin.io, lin.input)).toBe(0);
    const desktop = path.join(lin.home, ".local", "share", "applications", "mission-control.desktop");
    expect(readFileSync(desktop, "utf8")).toContain(`"${launcherMc(lin)}"`);
    expect(existsSync(path.join(lin.stateDir, "bin", "mc.js"))).toBe(true);

    const w = sandboxed({ platform: "win32" });
    expect(await install(["autostart"], w.io, w.input)).toBe(0);
    expect(readFileSync(path.join(w.stateDir, "autostart.vbs"), "utf8")).toContain(
      `"${path.join(w.stateDir, "bin", "mc.js")}"`,
    );
    expect(existsSync(path.join(w.stateDir, "bin", "mc.js"))).toBe(true);

    const mac = sandboxed({ platform: "darwin", uid: 501 });
    expect(await install(["autostart"], mac.io, mac.input)).toBe(0);
    const plist = path.join(mac.home, "Library", "LaunchAgents", "local.mission-control.plist");
    expect(readFileSync(plist, "utf8")).toContain(`<string>${path.join(mac.stateDir, "bin", "mc.js")}</string>`);
    expect(existsSync(path.join(mac.stateDir, "bin", "mc.js"))).toBe(true);

    const sd = sandboxed({ platform: "linux", hasSystemd: true });
    expect(await install(["autostart"], sd.io, sd.input)).toBe(0);
    const unit = path.join(sd.home, ".config", "systemd", "user", "mission-control.service");
    expect(readFileSync(unit, "utf8")).toContain(`"${launcherMc(sd)}"`);
    expect(existsSync(path.join(sd.stateDir, "bin", "mc.js"))).toBe(true);

    const xdg = sandboxed({ platform: "linux", hasSystemd: false });
    expect(await install(["autostart"], xdg.io, xdg.input)).toBe(0);
    const xdgFile = path.join(xdg.home, ".config", "autostart", "mission-control.desktop");
    expect(readFileSync(xdgFile, "utf8")).toContain(`"${launcherMc(xdg)}"`);
    expect(existsSync(path.join(xdg.stateDir, "bin", "mc.js"))).toBe(true);
  });

  it("LN-13 prepareLaunchers writes nothing on --dry-run", () => {
    const sb = sandboxed();
    const dry = makeCtx(sb.io, { ...sb.input, dryRun: true });
    expect(prepareLaunchers(dry)).toEqual({ changed: false });
    expect(existsSync(path.join(sb.stateDir, "bin"))).toBe(false);
    const wet = makeCtx(sb.io, { ...sb.input, dryRun: false });
    expect(prepareLaunchers(wet)).toEqual({ changed: true });
    expect(existsSync(path.join(sb.stateDir, "bin", "mc-hook.js"))).toBe(true);
  });
});
