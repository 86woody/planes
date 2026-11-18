import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readJson(join(ROOT, "package.json")).version;
const USAGE = "usage: node scripts/package.mjs [--out <dir>]";
const SHEBANG = "#!/usr/bin/env node";
const BANNER =
  'import { createRequire as __mcCreateRequire } from "node:module"; const require = __mcCreateRequire(import.meta.url);';
const PKG_DIRS = ["cli", "daemon", "hook"];
// D-47: dbus-next is pure JS and is bundled, so it is never an external.
const BUNDLED = new Set(["dbus-next"]);
// D-47: usocket and x11 stay external (optional requires of dbus-next, never dependencies).
const EXTRA_EXTERNALS = ["usocket", "x11"];
const ENTRIES = [
  ["packages/cli/src/mc.ts", "mc.js"],
  ["packages/daemon/src/bin.ts", "daemon.js"],
  ["packages/hook/src/mc-hook.ts", "mc-hook.js"],
];
const REQUIRED = [
  "packages/cli/src/mc.ts",
  "packages/daemon/src/bin.ts",
  "packages/hook/src/mc-hook.ts",
  "packages/ui/dist/index.html",
  "packages/vscode-bridge/dist/extension.cjs",
  "packages/contracts/dist/index.js",
  "packages/core/dist/index.js",
  "packages/platform/dist/index.js",
];
const PKG_FILES = [
  "dist",
  "ui",
  "ps",
  "macos-scripts",
  "assets",
  "shell",
  "schemas",
  "vscode-bridge.vsix",
];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fail(reason) {
  process.stderr.write(`PACKAGE FAIL ${reason}\n`);
  process.exit(1);
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim()}`);
  }
  return r;
}

function parseArgs(argv) {
  if (argv.length === 0) return resolve(ROOT, "release");
  if (argv.length === 2 && argv[0] === "--out" && argv[1]) return resolve(argv[1]);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

// Walks the cli, daemon and hook dependency graph through @mc/* packages and
// returns every third-party dependency with its installed version.
function collectExternals() {
  const found = new Map(); // name -> declaring package dir
  const visited = new Set();
  const queue = [...PKG_DIRS];
  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const dir = join(ROOT, "packages", name);
    const pkg = readJson(join(dir, "package.json"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith("@mc/")) queue.push(dep.slice("@mc/".length));
      else if (!BUNDLED.has(dep) && !found.has(dep)) found.set(dep, dir);
    }
  }
  const versions = new Map();
  for (const name of [...found.keys()].sort()) {
    // npm hoists to the root node_modules; a package-local copy (a version conflict) wins.
    const local = join(found.get(name), "node_modules", name, "package.json");
    const installed = existsSync(local) ? local : join(ROOT, "node_modules", name, "package.json");
    if (!existsSync(installed)) fail(`not installed: ${name}`);
    versions.set(name, readJson(installed).version);
  }
  return versions;
}

async function bundle(pkgDir, externals) {
  const names = [...externals.keys(), ...EXTRA_EXTERNALS];
  const external = names.flatMap((n) => [n, `${n}/*`]);
  for (const [entry, outName] of ENTRIES) {
    await esbuild.build({
      entryPoints: [join(ROOT, entry)],
      outfile: join(pkgDir, "dist", outName),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external,
      define: { __MC_PACKAGE__: JSON.stringify({ version: VERSION }) },
      banner: { js: BANNER },
      logLevel: "error",
    });
  }
}

function copyAssets(pkgDir) {
  const src = (rel) => join(ROOT, rel);
  const dst = (rel) => join(pkgDir, rel);
  cpSync(src("packages/ui/dist"), dst("ui"), { recursive: true });

  mkdirSync(dst("ps"), { recursive: true });
  const psSrc = src("packages/platform/src/windows/ps");
  for (const f of readdirSync(psSrc)) {
    if (f.endsWith(".ps1")) copyFileSync(join(psSrc, f), dst(join("ps", f)));
  }

  cpSync(src("packages/platform/src/macos/scripts"), dst("macos-scripts"), {
    recursive: true,
  });

  mkdirSync(dst("assets"), { recursive: true });
  copyFileSync(
    src("packages/platform/assets/icon-256.png"),
    dst(join("assets", "icon-256.png")),
  );

  mkdirSync(dst("shell"), { recursive: true });
  for (const f of ["mc.ps1", "mc.bash", "mc.zsh"]) {
    copyFileSync(src(join("packages/cli/assets/shell", f)), dst(join("shell", f)));
  }

  mkdirSync(dst("schemas"), { recursive: true });
  const schemaSrc = src("packages/contracts/schemas");
  for (const f of readdirSync(schemaSrc)) {
    if (f.endsWith(".json")) copyFileSync(join(schemaSrc, f), dst(join("schemas", f)));
  }
}

function buildVsix(out, pkgDir) {
  const bridgeDist = join(ROOT, "packages", "vscode-bridge", "dist");
  if (existsSync(bridgeDist)) {
    for (const f of readdirSync(bridgeDist)) {
      if (f.endsWith(".vsix")) rmSync(join(bridgeDist, f));
    }
  }
  sh("npm", ["--prefix", ROOT, "-w", "vscode-bridge", "run", "build"], ROOT);
  // T110: vsce reads every file of the package folder before applying .vscodeignore, so an output
  // file inside that folder (dist/) could be read while being written (ENOENT, a half-written zip).
  // Write the vsix to a fresh folder outside the package instead.
  const tmp = mkdtempSync(join(tmpdir(), "mc-vsix-"));
  const vsixSrc = join(tmp, `vscode-bridge-${VERSION}.vsix`);
  try {
    sh(
      "npm",
      ["--prefix", ROOT, "-w", "vscode-bridge", "exec", "--", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "-o", vsixSrc],
      ROOT,
    );
    if (!existsSync(vsixSrc)) fail("vsix not found");
    copyFileSync(vsixSrc, join(pkgDir, "vscode-bridge.vsix"));
    copyFileSync(vsixSrc, join(out, `vscode-bridge-${VERSION}.vsix`));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writePackageJson(pkgDir, externals) {
  const dependencies = {};
  for (const name of [...externals.keys()].sort()) {
    dependencies[name] = externals.get(name);
  }
  const obj = {
    name: "mission-control-desktop",
    version: VERSION,
    description: "Mission Control: local daemon, mc CLI and agent hooks",
    type: "module",
    bin: { mc: "dist/mc.js", "mc-hook": "dist/mc-hook.js" },
    engines: { node: ">=22" },
    dependencies,
    files: PKG_FILES,
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(obj, null, 2) + "\n");
}

function writeReadme(pkgDir) {
  const lines = [
    `# mission-control-desktop ${VERSION}`,
    "",
    "## Install",
    "",
    "```",
    `npm i -g ./mission-control-desktop-${VERSION}.tgz`,
    "mc init",
    "mc launch",
    "```",
    "",
    "## Reference",
    "",
    "- `mc install <target>` connects one target (an agent, `shell` or `autostart`).",
    "- `mc start` starts the daemon if needed. `mc open` opens the page. `mc launch` runs both.",
    "",
    "## Upgrade",
    "",
    "```",
    "mc stop",
    `npm i -g ./mission-control-desktop-<new>.tgz`,
    "mc launch",
    "```",
    "",
    "Hooks are not rewritten on upgrade.",
    "",
    "## Node switch",
    "",
    "`mc doctor` warns `hook-paths`. Run `mc init` (or `mc install <target>`) again; it repairs in place.",
    "",
    "## Uninstall",
    "",
    "```",
    "mc stop",
    "mc uninstall <each installed target>",
    "npm rm -g mission-control-desktop",
    "```",
    "",
    "Config and state dirs stay; config.md 1 lists where.",
    "",
  ];
  writeFileSync(join(pkgDir, "README.md"), lines.join("\n"));
}

// Every bin file must start with the node shebang, or npm writes a shim that hands
// the file to the OS .js association (T096). esbuild keeps mc-hook's own shebang.
function ensureShebangs(pkgDir) {
  const bins = Object.values(readJson(join(pkgDir, "package.json")).bin);
  for (const rel of bins) {
    const file = join(pkgDir, rel);
    const text = readFileSync(file, "utf8");
    const body = text.startsWith(`${SHEBANG}\n`) ? text.slice(SHEBANG.length + 1) : text;
    writeFileSync(file, `${SHEBANG}\n${body}`);
  }
}

async function main() {
  const out = parseArgs(process.argv.slice(2));

  for (const rel of REQUIRED) {
    if (!existsSync(join(ROOT, rel))) fail(`missing ${rel}: run npm run build`);
  }

  const pkgDir = join(out, "pkg");
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) {
    if (/^mission-control-desktop-.*\.tgz$/.test(f) || /^vscode-bridge-.*\.vsix$/.test(f)) {
      rmSync(join(out, f));
    }
  }
  mkdirSync(pkgDir, { recursive: true });

  const externals = collectExternals();
  await bundle(pkgDir, externals);
  copyAssets(pkgDir);
  buildVsix(out, pkgDir);
  writePackageJson(pkgDir, externals);
  ensureShebangs(pkgDir);
  writeReadme(pkgDir);

  sh("npm", ["pack", "--pack-destination", out], pkgDir);
  const tgzName = `mission-control-desktop-${VERSION}.tgz`;
  const tgz = join(out, tgzName);
  if (!existsSync(tgz)) fail("tarball not found");
  process.stdout.write(`PACKAGE ${tgzName} ${statSync(tgz).size}\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
