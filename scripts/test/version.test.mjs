import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERSION_SCRIPT = path.join(ROOT, "scripts", "version.mjs");
const COPY_SCRIPT = path.join(ROOT, "scripts", "copy-platform-assets.mjs");
const PACKAGE_NAMES = ["cli", "contracts", "core", "daemon", "hook", "platform", "ui", "vscode-bridge"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readText = (file) => fs.readFileSync(file, "utf8");

function runVersion(args, tree) {
  const env = { ...process.env };
  if (tree) env.MC_VERSION_ROOT = tree;
  else delete env.MC_VERSION_ROOT;
  return spawnSync(process.execPath, [VERSION_SCRIPT, ...args], { encoding: "utf8", env });
}

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ver-"));
  const manifest = (name, trailingNewline) =>
    JSON.stringify({ name, version: "1.0.0", private: true }, null, 2) + (trailingNewline ? "\n" : "");
  fs.writeFileSync(path.join(tmp, "package.json"), manifest("root", true));
  for (const [name, trailing] of [
    ["a", false],
    ["b", true],
    ["c", true],
  ]) {
    fs.mkdirSync(path.join(tmp, "packages", name), { recursive: true });
    fs.writeFileSync(path.join(tmp, "packages", name, "package.json"), manifest(name, trailing));
  }
  return tmp;
}

function manifestFiles(tree) {
  return [path.join(tree, "package.json"), ...["a", "b", "c"].map((n) => path.join(tree, "packages", n, "package.json"))];
}

function resolveAlias(alias, spec) {
  for (const { find, replacement } of alias) {
    const hit = find instanceof RegExp ? find.test(spec) : spec === find || spec.startsWith(find + "/");
    if (hit) return replacement;
  }
  return undefined;
}

test("VR-01 the root and all 8 packages/*/package.json carry the same x.y.z version (T111: read from the root)", () => {
  const version = readJson(path.join(ROOT, "package.json")).version;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const name of PACKAGE_NAMES) {
    expect(readJson(path.join(ROOT, "packages", name, "package.json")).version, name).toBe(version);
  }
});

test('VR-02 version.mjs check exits 0 on the repo and prints "version <root version> ok (9 manifests)"', () => {
  const version = readJson(path.join(ROOT, "package.json")).version;
  const result = runVersion(["check"]);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(`version ${version} ok (9 manifests)`);
});

test("VR-03 version.mjs check on a tree with one different version exits 1 and names that manifest", () => {
  const tree = makeTree();
  const file = path.join(tree, "packages", "b", "package.json");
  fs.writeFileSync(file, readText(file).replace('"version": "1.0.0"', '"version": "1.0.1"'));
  const result = runVersion(["check"], tree);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("version mismatch: packages/b/package.json has 1.0.1, root has 1.0.0");
});

test("VR-04 version.mjs set 1.2.3 rewrites every manifest, check then passes, and no other byte changes", () => {
  const tree = makeTree();
  const files = manifestFiles(tree);
  const before = files.map((f) => readText(f));
  const setResult = runVersion(["set", "1.2.3"], tree);
  expect(setResult.status).toBe(0);
  files.forEach((f, i) => {
    expect(readText(f)).toBe(before[i].replace('"version": "1.0.0"', '"version": "1.2.3"'));
  });
  expect(runVersion(["check"], tree).status).toBe(0);
});

test("VR-05 version.mjs set with an invalid version exits 2 and leaves every file unchanged", () => {
  const tree = makeTree();
  const files = manifestFiles(tree);
  const before = files.map((f) => readText(f));
  const result = runVersion(["set", "1.2"], tree);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("usage: node scripts/version.mjs set <x.y.z> | check");
  expect(files.map((f) => readText(f))).toEqual(before);
});

test("VR-06 the root package.json has scripts package, release and version:check with the exact commands", () => {
  const scripts = readJson(path.join(ROOT, "package.json")).scripts;
  expect(scripts.package).toBe("node scripts/package.mjs");
  expect(scripts.release).toBe("node scripts/release.mjs");
  expect(scripts["version:check"]).toBe("node scripts/version.mjs check");
});

test("VR-07 esbuild is a root devDependency and resolves from the repo root", () => {
  expect(typeof readJson(path.join(ROOT, "package.json")).devDependencies.esbuild).toBe("string");
  const require = createRequire(path.join(ROOT, "package.json"));
  expect(() => require.resolve("esbuild")).not.toThrow();
});

test("VR-08 platform package.json exports ./layout (types and default under dist) and its build runs copy-platform-assets.mjs", () => {
  const pkg = readJson(path.join(ROOT, "packages", "platform", "package.json"));
  expect(pkg.exports["./layout"]).toEqual({ types: "./dist/layout.d.ts", default: "./dist/layout.js" });
  expect(pkg.scripts.build).toBe("tsc -b && node ../../scripts/copy-platform-assets.mjs");
});

test("VR-09 copy-platform-assets.mjs copies src/macos/scripts/* to dist/macos/scripts and prints the count", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-copy-"));
  const src = path.join(tmp, "src", "macos", "scripts");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "a.js"), "console.log('a');\n");
  fs.writeFileSync(path.join(src, "b.applescript"), 'display notification "b"\n');
  const result = spawnSync(process.execPath, [COPY_SCRIPT, tmp], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("copied 2 files to");
  const dest = path.join(tmp, "dist", "macos", "scripts");
  expect(readText(path.join(dest, "a.js"))).toBe(readText(path.join(src, "a.js")));
  expect(readText(path.join(dest, "b.applescript"))).toBe(readText(path.join(src, "b.applescript")));
});

test("VR-10 copy-platform-assets.mjs exits 1 naming the path when src/macos/scripts is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-copy-"));
  const result = spawnSync(process.execPath, [COPY_SCRIPT, tmp], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(path.join(tmp, "src", "macos", "scripts"));
});

test("VR-12 the bridge manifest is named vscode-bridge, main is ./dist/extension.cjs, build writes dist/extension.cjs, and package passes the D-43 vsce flags", () => {
  const pkg = readJson(path.join(ROOT, "packages", "vscode-bridge", "package.json"));
  expect(pkg.name).toBe("vscode-bridge");
  expect(pkg.main).toBe("./dist/extension.cjs");
  expect(pkg.scripts.build).toContain("--outfile=dist/extension.cjs");
  expect(pkg.scripts.package).toBe(
    // T110: the D-43 flags, written to the repo's release/ (outside the package folder vsce reads).
    "npm run build && node -e \"require('node:fs').mkdirSync('../../release',{recursive:true})\" && vsce package --no-dependencies --allow-missing-repository --skip-license -o ../../release/",
  );
});

test("VR-15 in every vitest project @mc/platform/layout resolves through the alias to packages/platform/src/layout.ts while @mc/platform still resolves to src/index.ts", async () => {
  const projects = (await import("../../vitest.config.ts")).projects;
  expect(projects.length).toBeGreaterThan(0);
  const layoutTarget = path.normalize(path.join(ROOT, "packages", "platform", "src", "layout.ts"));
  const indexTarget = path.normalize(path.join(ROOT, "packages", "platform", "src", "index.ts"));
  for (const project of projects) {
    expect(Array.isArray(project.resolve.alias)).toBe(true);
    expect(path.normalize(resolveAlias(project.resolve.alias, "@mc/platform/layout"))).toBe(layoutTarget);
    expect(path.normalize(resolveAlias(project.resolve.alias, "@mc/platform"))).toBe(indexTarget);
  }
});

test("VR-16 vitest.config.ts defines a packaging project over packaging-test/**/*.test.mjs with testTimeout 600000, and no other project allows an empty file set", async () => {
  const projects = (await import("../../vitest.config.ts")).projects;
  const packaging = projects.find((p) => p.test.name === "packaging");
  expect(packaging).toBeDefined();
  expect(packaging.test.include).toEqual(["packaging-test/**/*.test.mjs"]);
  expect(packaging.test.testTimeout).toBe(600000);
  expect(packaging.test.passWithNoTests).toBe(true);
  for (const project of projects) {
    if (project.test.name === "packaging") continue;
    expect(project.test.passWithNoTests, project.test.name).toBe(false);
  }
});
