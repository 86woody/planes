import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpGetRaw } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IS_WIN = process.platform === "win32";
const PKG_NAME = "mission-control-desktop";
const LAUNCHER_RE = /^\/\/ mission-control launcher\. target: (.+)\. version: (.+)$/;

let tempRoot;
let prefix1;
let prefix2;
let mchome;
let claude;
let env;
let seed;
let realCache;
let tarball;

function rootVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

// Real path, compared case-insensitively with forward slashes on Windows.
function key(p) {
  const r = realpathSync.native(p);
  return IS_WIN ? r.replace(/\\/g, "/").toLowerCase() : r;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeout,
    encoding: "utf8",
    shell: opts.shell ?? false,
    windowsHide: true,
    windowsVerbatimArguments: opts.verbatim ?? false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// npm is npm.cmd on Windows, so it runs through the shell with every argument quoted.
function npmRun(args, opts = {}) {
  if (IS_WIN) {
    return sh(["npm", ...args.map((a) => `"${a}"`)].join(" "), [], { ...opts, shell: true });
  }
  return sh("npm", args, opts);
}

function shimPath(prefix, name = "mc") {
  return IS_WIN ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name);
}

function install(prefix) {
  const r = npmRun(
    [
      "i",
      "-g",
      "--prefix",
      prefix,
      "--cache",
      realCache,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      tarball,
    ],
    { env, timeout: 240000 },
  );
  expect(r.code, `npm i -g failed: ${r.stderr}`).toBe(0);
  return r;
}

// Runs an installed bin through its npm shim, the way a user does (T096).
// Windows: the .cmd shim goes through cmd.exe (Node will not spawn a .cmd directly),
// with the command line passed verbatim so cmd's quoting rules apply.
function runShim(shim, args, input, timeout) {
  if (IS_WIN) {
    const line = `"${shim} ${args.join(" ")}"`;
    return sh("cmd.exe", ["/d", "/s", "/c", line], { env, input, timeout, verbatim: true });
  }
  return sh(shim, args, { env, input, timeout });
}

function mc(prefix, args) {
  return runShim(shimPath(prefix), args, undefined, 120000);
}

function launcherLine(file) {
  return readFileSync(file, "utf8").split("\n")[0].replace(/\r$/, "");
}

function launcherTarget(file) {
  const m = launcherLine(file).match(LAUNCHER_RE);
  expect(m, `${file} is not a launcher`).not.toBeNull();
  return { target: m[1], version: m[2] };
}

function readDaemon() {
  const f = join(mchome, "state", "daemon.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

// Polls fn every 100 ms until it returns a truthy value or ms elapses.
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function httpGet(port, path) {
  return new Promise((done, fail) => {
    const req = httpGetRaw({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode, body }));
    });
    req.on("error", fail);
    req.setTimeout(10000, () => req.destroy(new Error(`GET ${path} timed out`)));
  });
}

describe("package install", () => {
  let seedSettings;

  beforeAll(() => {
    tarball = join(ROOT, "release", `${PKG_NAME}-${rootVersion()}.tgz`);
    if (!existsSync(tarball)) throw new Error("run npm run package first");

    // Read the real npm cache before the env is overridden below.
    realCache = npmRun(["config", "get", "cache"], { env: process.env }).stdout.trim();

    tempRoot = mkdtempSync(join(tmpdir(), "mc-pkg-"));
    prefix1 = join(tempRoot, "prefix1");
    prefix2 = join(tempRoot, "prefix2");
    const home = join(tempRoot, "home");
    mchome = join(tempRoot, "mchome");
    claude = join(tempRoot, "claude");
    for (const d of [prefix1, prefix2, home, mchome, claude]) mkdirSync(d, { recursive: true });

    env = {
      ...process.env,
      MC_HOME: mchome,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CLAUDE_CONFIG_DIR: claude,
      MC_PORT: "0",
    };
    delete env.MC_PLATFORM;
    delete env.MC_TEST;

    seed = {
      theme: "dark",
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo", args: ["x"] }] }],
      },
    };
    seedSettings = join(claude, "settings.json");
    writeFileSync(seedSettings, JSON.stringify(seed, null, 2) + "\n");

    install(prefix1);
  }, 300000);

  afterAll(() => {
    if (!tempRoot) return;
    for (const p of [prefix2, prefix1]) {
      try {
        mc(p, ["stop"]);
      } catch {
        // either install may already be gone
      }
    }
    try {
      const pid = JSON.parse(readFileSync(join(mchome, "state", "daemon.json"), "utf8")).pid;
      process.kill(pid);
    } catch {
      // no daemon.json, or the process is already gone
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }, 300000);

  it("SK-01 mc --version of the installed package prints the root package.json version", () => {
    const r = mc(prefix1, ["--version"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(rootVersion());
    expect(existsSync(shimPath(prefix1))).toBe(true);
  });

  it("SK-02 mc install claude-code writes hooks that point at the launcher in MC_HOME/state/bin, and the launcher targets the installed package", () => {
    const r = mc(prefix1, ["install", "claude-code"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("uri-handler skipped (MC_HOME set)");

    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    const hooks = [];
    for (const groups of Object.values(settings.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const h of group.hooks ?? []) {
          if (Array.isArray(h.args) && h.args.length === 2 && h.args[1] === "claude-code") {
            hooks.push(h);
          }
        }
      }
    }
    expect(hooks.length).toBeGreaterThanOrEqual(9);

    const launcher = join(mchome, "state", "bin", "mc-hook.js");
    for (const h of hooks) {
      expect(key(h.args[0])).toBe(key(launcher));
    }

    const { target, version } = launcherTarget(launcher);
    expect(key(target).startsWith(key(prefix1))).toBe(true);
    expect(target.replace(/\\/g, "/").endsWith("dist/mc-hook.js")).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(version).toBe(rootVersion());
  });

  it("SK-03 the launcher run with a fixture Claude payload exits 0 within 1500 ms and leaves a spool file", () => {
    const payload = readFileSync(
      join(ROOT, "packages", "contracts", "fixtures", "ingest", "raw", "cc-session-start.json"),
      "utf8",
    );
    const started = Date.now();
    const r = sh(process.execPath, [join(mchome, "state", "bin", "mc-hook.js"), "claude-code"], {
      env,
      input: payload,
      timeout: 5000,
    });
    const elapsed = Date.now() - started;
    expect(r.code, r.stderr).toBe(0);
    expect(elapsed).toBeLessThan(1500);
    expect(r.stdout).toBe("");

    const spool = join(mchome, "state", "spool");
    expect(existsSync(spool) && readdirSync(spool).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("SK-04 mc start runs the packaged daemon: /healthz reports the root version and GET / serves the UI index, then mc stop", async () => {
    const daemonFile = join(mchome, "state", "daemon.json");
    let stopped;
    try {
      const started = mc(prefix1, ["start"]);
      expect(started.code, started.stderr).toBe(0);

      const info = await waitFor(readDaemon, 15000);
      expect(info).toBeTruthy();
      expect(info.port).toBeGreaterThan(0);

      const health = await httpGet(info.port, "/healthz");
      expect(health.status).toBe(200);
      const body = JSON.parse(health.body);
      expect(body.ok).toBe(true);
      expect(body.version).toBe(rootVersion());

      const index = await httpGet(info.port, "/");
      expect(index.status).toBe(200);
      expect(index.body).toContain("<html");
    } finally {
      stopped = mc(prefix1, ["stop"]);
    }
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(await waitFor(() => !existsSync(daemonFile), 15000)).toBeTruthy();
  });

  it("SK-05 reinstalling into a second prefix then mc start rewrites the launcher target", () => {
    rmSync(prefix1, { recursive: true, force: true });
    install(prefix2);
    try {
      const started = mc(prefix2, ["start"]);
      expect(started.code, started.stderr).toBe(0);

      const hook = launcherTarget(join(mchome, "state", "bin", "mc-hook.js"));
      const cli = launcherTarget(join(mchome, "state", "bin", "mc.js"));
      expect(key(hook.target).startsWith(key(prefix2))).toBe(true);
      expect(existsSync(hook.target)).toBe(true);
      expect(hook.target.replace(/\\/g, "/").endsWith("dist/mc-hook.js")).toBe(true);
      expect(key(cli.target).startsWith(key(prefix2))).toBe(true);
      expect(existsSync(cli.target)).toBe(true);
      expect(cli.target.replace(/\\/g, "/").endsWith("dist/mc.js")).toBe(true);
    } finally {
      mc(prefix2, ["stop"]);
    }
  });

  it("SK-06 mc uninstall claude-code from the second prefix restores the settings file to its seeded content", () => {
    const r = mc(prefix2, ["uninstall", "claude-code"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual(seed);
  });

  it("SK-07 the installed mc-hook shim runs the hook and exits 0", () => {
    const payload = readFileSync(
      join(ROOT, "packages", "contracts", "fixtures", "ingest", "raw", "cc-session-start.json"),
      "utf8",
    );
    const started = Date.now();
    const r = runShim(shimPath(prefix2, "mc-hook"), ["claude-code"], payload, 5000);
    const elapsed = Date.now() - started;
    expect(r.code, r.stderr).toBe(0);
    expect(elapsed).toBeLessThan(1500);
  });

  it("SK-08 mc uninstall --all --purge after claude-code and copilot installs, then npm rm -g, leaves nothing in the prefix or MC_HOME", () => {
    const prefix3 = join(tempRoot, "prefix3");
    const copilotHome = join(tempRoot, "copilot");
    mkdirSync(prefix3, { recursive: true });
    mkdirSync(copilotHome, { recursive: true });
    const copilotFile = join(copilotHome, "hooks", "mission-control.json");
    const prevCopilot = env.COPILOT_HOME;
    env.COPILOT_HOME = copilotHome;
    try {
      install(prefix3);
      const a = mc(prefix3, ["install", "claude-code"]);
      expect(a.code, a.stderr).toBe(0);
      const b = mc(prefix3, ["install", "copilot"]);
      expect(b.code, b.stderr).toBe(0);
      expect(existsSync(copilotFile)).toBe(true);

      const up = mc(prefix3, ["uninstall", "--all", "--purge"]);
      expect(up.code, up.stderr || up.stdout).toBe(0);

      const rm = npmRun(["rm", "-g", PKG_NAME, "--prefix", prefix3], { env, timeout: 240000 });
      expect(rm.code, rm.stderr).toBe(0);

      expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(JSON.stringify(seed, null, 2) + "\n");
      expect(existsSync(copilotFile)).toBe(false);
      expect(existsSync(shimPath(prefix3))).toBe(false);
      expect(existsSync(join(prefix3, "node_modules", PKG_NAME))).toBe(false);
      expect(existsSync(join(prefix3, "lib", "node_modules", PKG_NAME))).toBe(false);
      expect(existsSync(join(mchome, "config"))).toBe(false);
      expect(existsSync(join(mchome, "state"))).toBe(false);
    } finally {
      if (prevCopilot === undefined) delete env.COPILOT_HOME;
      else env.COPILOT_HOME = prevCopilot;
    }
  });
});
