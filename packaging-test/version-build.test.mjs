import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function npm(args) {
  return spawnSync("npm", args, { cwd: ROOT, shell: true, encoding: "utf8" });
}

test("VR-11 after a build packages/platform/dist/macos/scripts holds every file of src/macos/scripts", () => {
  const src = path.join(ROOT, "packages", "platform", "src", "macos", "scripts");
  const dest = path.join(ROOT, "packages", "platform", "dist", "macos", "scripts");
  const srcNames = fs.readdirSync(src).sort();
  expect(srcNames.length).toBeGreaterThan(0);
  expect(fs.readdirSync(dest).sort()).toEqual(srcNames);
});

test(
  "VR-13 npm run build -w vscode-bridge writes packages/vscode-bridge/dist/extension.cjs",
  () => {
    const result = npm(["run", "build", "-w", "vscode-bridge"]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(ROOT, "packages", "vscode-bridge", "dist", "extension.cjs"))).toBe(true);
  },
  120000,
);

test(
  "VR-14 npm run package -w vscode-bridge writes release/vscode-bridge-<version>.vsix (outside the package, T110), a zip that lists extension/dist/extension.cjs",
  () => {
    const result = npm(["run", "package", "-w", "vscode-bridge"]);
    expect(result.status, result.stderr).toBe(0);
    const vsix = path.join(ROOT, "release", `vscode-bridge-${VERSION}.vsix`);
    expect(fs.existsSync(path.join(ROOT, "packages", "vscode-bridge", "dist", `vscode-bridge-${VERSION}.vsix`))).toBe(false);
    expect(fs.existsSync(vsix)).toBe(true);
    const buf = fs.readFileSync(vsix);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.includes("extension/dist/extension.cjs")).toBe(true);
  },
  120000,
);
