import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layout, layoutFor, type Layout } from "@mc/platform/layout";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/main.js";
import { run as install } from "../src/commands/install.js";
import { healLaunchers } from "../src/commands/start.js";
import { checksFor, type Outcome } from "../src/lib/doctor-checks.js";
import { DAEMON_BIN, REPO_ROOT, resolveCliPaths } from "../src/lib/paths.js";
import { koffiRequire, koffiRequireBase } from "../src/lib/system.js";
import { launcherPaths, launcherText, readLauncherTarget } from "../src/installers/launcher.js";
import { isAlive, readDaemonFile } from "../src/lib/daemon.js";
import { type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

// Parsed JSON in these tests is read by key path; the shape is checked by the assertions themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const made: Sandbox[] = [];
const dirs: string[] = [];
const startedPids: number[] = [];
let daemonEnv: NodeJS.ProcessEnv | null = null;

afterEach(async () => {
  // Stop the daemon before the MC_HOME it reads its daemon.json from is deleted.
  if (daemonEnv) {
    const started = readDaemonFile(resolveCliPaths(daemonEnv));
    if (started) startedPids.push(started.pid);
    await main(["stop"], capture(daemonEnv).io);
    if (started && isAlive(started.pid)) {
      try {
        process.kill(started.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    daemonEnv = null;
  }
  for (const s of made.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandboxed(opts?: Parameters<typeof sandbox>[0]): Sandbox {
  const s = sandbox(opts);
  made.push(s);
  return s;
}

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function capture(env: NodeJS.ProcessEnv): { out: string[]; err: string[]; io: Io } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: process.cwd() } };
}

/** A fake packaged install: dist/mc.js, dist/mc-hook.js, dist/daemon.js and shell assets, all in a temp dir. */
function packageLayout(): Layout {
  const dir = tempDir("mc-pkg-");
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  for (const f of ["mc.js", "mc-hook.js", "daemon.js"]) writeFileSync(path.join(dir, "dist", f), "// fake\n");
  mkdirSync(path.join(dir, "shell"), { recursive: true });
  writeFileSync(path.join(dir, "shell", "mc.bash"), "# mc shell snippet\n");
  return layoutFor("package", dir, "9.9.9");
}

function hookCheck(env: NodeJS.ProcessEnv, home: string, lay: Layout) {
  const check = checksFor("linux", env, home, lay).find((c) => c.id === "hook-paths");
  if (!check) throw new Error("no hook-paths check");
  return check;
}

const detailOf = (o: Outcome): string => (typeof o === "string" ? o : o.detail);

const settingsFile = (sb: Sandbox): string => path.join(sb.claudeDir, "settings.json");
const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8"));

describe("packaged CLI", () => {
  it("PC-01 mc --version and -v print layout().version and exit 0", async () => {
    const c = capture({});
    expect(await main(["--version"], c.io)).toBe(0);
    expect(await main(["-v"], c.io)).toBe(0);
    expect(c.out).toEqual([layout().version, layout().version]);
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(layout().version).toBe(rootPkg.version);

    const usage = capture({});
    await main([], usage.io);
    expect(usage.err.join("\n")).toContain("--version, -v");
  });

  it("PC-02 REPO_ROOT and DAEMON_BIN come from layout()", () => {
    expect(REPO_ROOT).toBe(layout().root);
    expect(DAEMON_BIN).toBe(layout().daemonJs);
  });

  it("PC-03 koffiRequireBase is the root package.json in package mode and the platform package.json in clone mode", () => {
    // layoutFor resolves the root to an absolute path, so the expectations build on lay.root.
    const clone = layoutFor("clone", "/r", "1");
    expect(koffiRequireBase(clone)).toBe(path.join(clone.root, "packages", "platform", "package.json"));
    const pkg = layoutFor("package", "/p", "1");
    expect(koffiRequireBase(pkg)).toBe(path.join(pkg.root, "package.json"));
  });

  it("PC-04 koffiRequire resolves koffi in clone mode and from <package>/node_modules in package mode", () => {
    expect(() => koffiRequire().resolve("koffi")).not.toThrow();

    const tmp = tempDir("mc-koffi-");
    writeFileSync(path.join(tmp, "package.json"), '{"name":"x"}');
    mkdirSync(path.join(tmp, "node_modules", "koffi"), { recursive: true });
    writeFileSync(path.join(tmp, "node_modules", "koffi", "package.json"), '{"name":"koffi","main":"index.js"}');
    writeFileSync(path.join(tmp, "node_modules", "koffi", "index.js"), "module.exports = { marker: 1 };\n");
    expect((koffiRequire(layoutFor("package", tmp, "1")) as (id: string) => Json)("koffi").marker).toBe(1);
  });

  it("PC-05 doctor hook-paths is ok when nothing is installed and has the frozen id, label, fix and required flag", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    for (const platform of ["win32", "darwin", "linux"]) {
      const check = checksFor(platform, sb.io.env, sb.home, lay).find((c) => c.id === "hook-paths");
      expect(check).toBeDefined();
      expect(check?.label).toBe("Hook paths current");
      expect(check?.fix).toBe("mc install <target>");
      expect(check?.required).toBe(false);
      expect(await check?.run()).toEqual({ status: "ok", detail: "nothing installed" });
    }
  });

  it("PC-06 doctor hook-paths is ok right after an install", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    sb.input.layout = lay;
    sb.input.nodePath = process.execPath;
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    expect(await hookCheck(sb.io.env, sb.home, lay).run()).toBe("ok");
  });

  it("PC-07 doctor hook-paths warns when the launcher targets another layout", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    sb.input.layout = lay;
    sb.input.nodePath = process.execPath;
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    const other = packageLayout();
    const outcome = await hookCheck(sb.io.env, sb.home, other).run();
    expect(typeof outcome).not.toBe("string");
    expect(outcome).toMatchObject({ status: "warn" });
    expect(detailOf(outcome)).toContain("launcher targets");
    expect(detailOf(outcome)).toContain("this install is");
  });

  it("PC-08 doctor hook-paths warns when the launcher target file is missing", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    sb.input.layout = lay;
    sb.input.nodePath = process.execPath;
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);
    rmSync(lay.hookJs);
    const outcome = await hookCheck(sb.io.env, sb.home, lay).run();
    expect(outcome).toMatchObject({ status: "warn" });
    expect(detailOf(outcome)).toContain("launcher target missing");
  });

  it("PC-09 doctor hook-paths warns about duplicate mc groups and a missing command", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    sb.input.layout = lay;
    sb.input.nodePath = process.execPath;
    expect(await install(["claude-code"], sb.io, sb.input)).toBe(0);

    const settings = readJson(settingsFile(sb));
    settings.hooks.Stop.push(JSON.parse(JSON.stringify(settings.hooks.Stop[0])));
    writeFileSync(settingsFile(sb), JSON.stringify(settings, null, 2) + "\n");
    expect(detailOf(await hookCheck(sb.io.env, sb.home, lay).run())).toContain("2 mc hooks for Stop");

    for (const groups of Object.values(settings.hooks) as Json[]) {
      for (const group of groups) for (const h of group.hooks) h.command = "/nonexistent/node";
    }
    writeFileSync(settingsFile(sb), JSON.stringify(settings, null, 2) + "\n");
    expect(detailOf(await hookCheck(sb.io.env, sb.home, lay).run())).toContain("command missing /nonexistent/node");
  });

  it("PC-10 doctor hook-paths covers codex and shell.env", async () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    sb.input.layout = lay;
    sb.input.nodePath = process.execPath;
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    expect(await install(["shell", "--bash"], sb.io, sb.input)).toBe(0);
    expect(await hookCheck(sb.io.env, sb.home, lay).run()).toBe("ok");

    const other = packageLayout();
    const detail = detailOf(await hookCheck(sb.io.env, sb.home, other).run());
    expect(detail).toContain("codex: launcher targets");
    expect(detail).toContain("shell: launcher targets");
  });

  it("PC-11 healLaunchers rewrites stale launchers, prints one line, and then stays silent", () => {
    const sb = sandboxed({ platform: "linux" });
    const lay = packageLayout();
    mkdirSync(sb.stateDir, { recursive: true });
    writeFileSync(path.join(sb.stateDir, "install-manifest.json"), '{"claude-code":{}}');
    const bin = launcherPaths(sb.stateDir);
    mkdirSync(bin.dir, { recursive: true });
    writeFileSync(bin.hookJs, launcherText("hook", "/old/x.js", "0"));
    writeFileSync(bin.mcJs, launcherText("mc", "/old/y.js", "0"));

    const paths = resolveCliPaths(sb.io.env);
    expect(healLaunchers(paths, sb.io, lay)).toBe(true);
    expect(sb.out).toEqual([`launchers updated -> ${lay.root}`]);
    expect(readLauncherTarget(bin.hookJs)).toBe(lay.hookJs);
    expect(readLauncherTarget(bin.mcJs)).toBe(lay.mcJs);

    expect(healLaunchers(paths, sb.io, lay)).toBe(false);
    expect(sb.out).toEqual([`launchers updated -> ${lay.root}`]);
  });

  it("PC-12 healLaunchers writes nothing without a manifest entry", () => {
    const lay = packageLayout();
    const noFile = sandboxed({ platform: "linux" });
    expect(healLaunchers(resolveCliPaths(noFile.io.env), noFile.io, lay)).toBe(false);
    expect(existsSync(path.join(noFile.stateDir, "bin"))).toBe(false);

    const empty = sandboxed({ platform: "linux" });
    mkdirSync(empty.stateDir, { recursive: true });
    writeFileSync(path.join(empty.stateDir, "install-manifest.json"), "{}");
    expect(healLaunchers(resolveCliPaths(empty.io.env), empty.io, lay)).toBe(false);
    expect(existsSync(path.join(empty.stateDir, "bin"))).toBe(false);
  });

  it(
    "PC-13 mc start heals the launchers before starting the daemon",
    async () => {
      const mcHome = tempDir("mc-start-");
      const env: NodeJS.ProcessEnv = { ...process.env, MC_HOME: mcHome, MC_PORT: "0", MC_PLATFORM: "fake", MC_TEST: "1" };
      daemonEnv = env;
      const stateDir = resolveCliPaths(env).stateDir;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(path.join(stateDir, "install-manifest.json"), '{"claude-code":{}}');
      const bin = launcherPaths(stateDir);
      mkdirSync(bin.dir, { recursive: true });
      writeFileSync(bin.hookJs, launcherText("hook", "/old/x.js", "0"));
      writeFileSync(bin.mcJs, launcherText("mc", "/old/y.js", "0"));

      const c = capture(env);
      expect(await main(["start"], c.io)).toBe(0);
      expect(c.out[0]).toBe(`launchers updated -> ${layout().root}`);
      expect(c.out.slice(1).some((l) => l.includes("started pid="))).toBe(true);
      expect(readLauncherTarget(bin.hookJs)).toBe(layout().hookJs);
      expect(readLauncherTarget(bin.mcJs)).toBe(layout().mcJs);
    },
    30_000,
  );

  it("LK-01 no daemon started by this file is still running", async () => {
    expect(startedPids.length).toBeGreaterThanOrEqual(1);
    const deadline = Date.now() + 2_000;
    while (startedPids.some((pid) => isAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const pid of startedPids) expect(isAlive(pid)).toBe(false);
  });
});
