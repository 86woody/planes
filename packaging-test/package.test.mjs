import { test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TGZ = `mission-control-desktop-${VERSION}.tgz`;
const VSIX = `vscode-bridge-${VERSION}.vsix`;
const OUT = mkdtempSync(join(tmpdir(), "mc-pack-"));
const PKG = join(OUT, "pkg");

const DEPENDENCY_NAMES = [
  "@fastify/cookie",
  "@fastify/static",
  "@fastify/websocket",
  "@github/copilot-sdk",
  "ajv",
  "ajv-formats",
  "fastify",
  "koffi",
  "ws",
];
const FILES_LIST = [
  "dist",
  "ui",
  "ps",
  "macos-scripts",
  "assets",
  "shell",
  "schemas",
  "vscode-bridge.vsix",
];

let run;
let tarEntries;

function listFiles(dir) {
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
}

function readBundle(name) {
  return readFileSync(join(PKG, "dist", name), "utf8");
}

beforeAll(() => {
  run = spawnSync(process.execPath, [join(ROOT, "scripts", "package.mjs"), "--out", OUT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const listing = spawnSync("tar", ["-tzf", TGZ], { cwd: OUT, encoding: "utf8" });
  tarEntries = (listing.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter((l) => l.length > 0 && !l.endsWith("/"));
}, 600_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

test("PK-01 package.mjs exits 0 and its last line is PACKAGE <tgz name> <bytes> with the real file size", () => {
  // T108: the gate has seen this fail with nothing recorded; keep the script's own output on failure.
  expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}\nerror: ${String(run.error ?? "")}`).toBe(0);
  const lines = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  const re = new RegExp(`^PACKAGE mission-control-desktop-${VERSION.replace(/\./g, "\\.")}\\.tgz (\\d+)$`);
  const m = re.exec(last ?? "");
  expect(m).not.toBeNull();
  expect(Number(m[1])).toBe(statSync(join(OUT, TGZ)).size);
});

test("PK-02 the tarball contains exactly the PACKAGING.md 2 layout and nothing else", () => {
  const entries = tarEntries;
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) expect(e.startsWith("package/")).toBe(true);
  const rel = new Set(entries.map((e) => e.slice("package/".length)));

  const required = [
    "package.json",
    "README.md",
    "dist/mc.js",
    "dist/daemon.js",
    "dist/mc-hook.js",
    "ui/index.html",
    "assets/icon-256.png",
    "shell/mc.ps1",
    "shell/mc.bash",
    "shell/mc.zsh",
    "vscode-bridge.vsix",
  ];
  for (const r of required) expect(rel.has(r)).toBe(true);

  for (const f of readdirSync(join(ROOT, "packages/platform/src/windows/ps"))) {
    if (f.endsWith(".ps1")) expect(rel.has(`ps/${f}`)).toBe(true);
  }
  for (const f of listFiles(join(ROOT, "packages/platform/src/macos/scripts"))) {
    expect(rel.has(`macos-scripts/${f}`)).toBe(true);
  }
  for (const f of readdirSync(join(ROOT, "packages/contracts/schemas"))) {
    if (f.endsWith(".json")) expect(rel.has(`schemas/${f}`)).toBe(true);
  }
  expect([...rel].some((r) => r.startsWith("ui/assets/"))).toBe(true);

  const allowed = [
    "package.json",
    "README.md",
    "dist/",
    "ui/",
    "ps/",
    "macos-scripts/",
    "assets/",
    "shell/",
    "schemas/",
    "vscode-bridge.vsix",
  ];
  for (const r of rel) {
    expect(allowed.some((p) => r === p || r.startsWith(p))).toBe(true);
    expect(r.includes("node_modules/")).toBe(false);
    expect(r.includes("/src/")).toBe(false);
    expect(r.endsWith(".map")).toBe(false);
  }
});

test("PK-03 the generated package.json has the pinned name, version, bin, engines, files and exact-version dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  expect(pkg.name).toBe("mission-control-desktop");
  expect(pkg.version).toBe(VERSION);
  expect(pkg.type).toBe("module");
  expect(pkg.bin).toEqual({ mc: "dist/mc.js", "mc-hook": "dist/mc-hook.js" });
  expect(pkg.engines).toEqual({ node: ">=22" });
  expect(pkg.files).toEqual(FILES_LIST);
  expect(Object.keys(pkg.dependencies)).toEqual(DEPENDENCY_NAMES);
  for (const v of Object.values(pkg.dependencies)) {
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.includes("^")).toBe(false);
    expect(v.includes("~")).toBe(false);
  }
});

test("PK-04 no bundle still imports an @mc/ package", () => {
  const re = /(from\s*|import\s*\(\s*|require\s*\(\s*)["']@mc\//;
  for (const b of ["mc.js", "daemon.js", "mc-hook.js"]) {
    expect(re.test(readBundle(b))).toBe(false);
  }
});

test("PK-05 __MC_PACKAGE__ is defined away in the bundles and the version is inlined", () => {
  // esbuild keeps `// <define:__MC_PACKAGE__>` labels next to the inlined value; they are not references.
  for (const b of ["mc.js", "daemon.js", "mc-hook.js"]) {
    const text = readBundle(b).split("<define:__MC_PACKAGE__>").join("");
    expect(/\b__MC_PACKAGE__\b/.test(text)).toBe(false);
  }
  const re = new RegExp(`version:\\s*"${VERSION.replace(/\./g, "\\.")}"`);
  expect(re.test(readBundle("mc.js"))).toBe(true);
  expect(re.test(readBundle("daemon.js"))).toBe(true);
});

test("PK-06 the externals stay imports in the bundles and the hook keeps its shebang", () => {
  const daemon = readBundle("daemon.js");
  expect(daemon.includes('from "fastify"')).toBe(true);
  expect(daemon.includes('from "ws"')).toBe(true);
  expect(daemon.includes("node_modules/fastify")).toBe(false);
  expect(readBundle("mc-hook.js").startsWith("#!/usr/bin/env node")).toBe(true);
  for (const b of ["mc.js", "daemon.js", "mc-hook.js"]) {
    expect(readBundle(b).includes("__mcCreateRequire")).toBe(true);
  }
});

test("PK-07 the vsix is a zip, identical in release/ and in the package, and README names the install commands", () => {
  const top = join(OUT, VSIX);
  const inPkg = join(PKG, "vscode-bridge.vsix");
  expect(existsSync(top)).toBe(true);
  expect(existsSync(inPkg)).toBe(true);
  const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const a = readFileSync(top);
  const b = readFileSync(inPkg);
  expect(a.subarray(0, 4).equals(magic)).toBe(true);
  expect(b.subarray(0, 4).equals(magic)).toBe(true);
  expect(a.equals(b)).toBe(true);
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  expect(readme).toContain(`npm i -g ./mission-control-desktop-${VERSION}.tgz`);
  expect(readme).toContain("mc init");
  expect(readme).toContain("mc launch");
  expect(readme.slice(readme.indexOf("## Reference")).includes("mc install")).toBe(true);
  expect(readme).toContain("npm rm -g mission-control-desktop");
});

test("PK-08 a bad flag exits 2 with usage and an --out without a value exits 2", () => {
  const script = join(ROOT, "scripts", "package.mjs");
  const bogus = spawnSync(process.execPath, [script, "--bogus"], { cwd: ROOT, encoding: "utf8" });
  expect(bogus.status).toBe(2);
  expect(bogus.stderr).toContain("usage:");

  const fresh = join(tmpdir(), `mc-pack-novalue-${process.pid}-${Date.now()}`);
  const withOut = spawnSync(process.execPath, [script, "--bogus", "--out", fresh], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(withOut.status).toBe(2);
  expect(withOut.stderr).toContain("usage:");
  expect(existsSync(fresh)).toBe(false);

  const noValue = spawnSync(process.execPath, [script, "--out"], { cwd: ROOT, encoding: "utf8" });
  expect(noValue.status).toBe(2);
  expect(noValue.stderr).toContain("usage:");
});

test("PK-09 dbus-next is bundled and usocket is neither bundled nor a dependency", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  expect(Object.prototype.hasOwnProperty.call(pkg.dependencies, "dbus-next")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(pkg.dependencies, "usocket")).toBe(false);
  const daemon = readBundle("daemon.js");
  expect(daemon.includes('require("usocket")') || daemon.includes("require('usocket')")).toBe(true);
  expect(tarEntries.some((e) => e.includes("node_modules/usocket"))).toBe(false);
});

test("PK-10 every bin file in the package starts with the node shebang", () => {
  const SHEBANG = "#!/usr/bin/env node";
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  const bins = Object.values(pkg.bin);
  expect(bins.length).toBeGreaterThan(0);
  for (const rel of bins) {
    const text = readFileSync(join(PKG, rel), "utf8");
    expect(text.split("\n")[0].replace(/\r$/, "")).toBe(SHEBANG);
    expect(text.split(SHEBANG).length - 1).toBe(1);
  }
});
