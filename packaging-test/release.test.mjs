import { test, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const NOTES = readFileSync(join(ROOT, "RELEASE-NOTES.md"), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "mc-release-test-"));
const OUT = join(TMP, "out");
const OUT2 = join(TMP, "out2");

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function unverifiedSection() {
  const lines = NOTES.split(/\r?\n/);
  const start = lines.indexOf("## Unverified");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n");
}

test("RN-01 the notes have an Unverified section naming AC-07, the macOS rows of AC-09, MO-01..MO-06 and the Windows Sandbox proof", () => {
  const section = unverifiedSection();
  expect(section).toContain("AC-07");
  expect(section).toContain("macOS rows of AC-09");
  expect(section).toContain("MO-01..MO-06");
  expect(section).toContain("fresh-machine proof: Windows Sandbox only");
});

test("RN-02 the notes title carries the version of the root package.json", () => {
  expect(NOTES.split(/\r?\n/)[0]).toBe(`# mission-control-desktop ${VERSION}`);
});

test("RN-03 the notes give the install (npm i -g, mc init, mc launch), upgrade and uninstall commands of PACKAGING.md 5", () => {
  for (const text of [
    `npm i -g ./mission-control-desktop-${VERSION}.tgz`,
    "mc init",
    "mc launch",
    "mc install vscode",
    "mc start",
    "mc open",
    "mc stop",
    "mc uninstall <each installed target>",
    "npm rm -g mission-control-desktop",
    "mc doctor",
  ]) {
    expect(NOTES).toContain(text);
  }
});

test("RN-04 release --skip-gate leaves the tgz, the vsix and the notes in the out dir and prints RELEASE <v> <out>", () => {
  const r = spawnSync(process.execPath, ["scripts/release.mjs", "--skip-gate", "--out", OUT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // T104: the gate once saw exit 1 here with nothing recorded; keep the script's own output on failure.
  expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  const lines = r.stdout.trimEnd().split(/\r?\n/);
  expect(lines[lines.length - 1]).toBe(`RELEASE ${VERSION} ${OUT}`);
  expect(existsSync(join(OUT, `mission-control-desktop-${VERSION}.tgz`))).toBe(true);
  expect(existsSync(join(OUT, `vscode-bridge-${VERSION}.vsix`))).toBe(true);
  expect(existsSync(join(OUT, "RELEASE-NOTES.md"))).toBe(true);
  expect(readFileSync(join(OUT, "RELEASE-NOTES.md"))).toEqual(readFileSync(join(ROOT, "RELEASE-NOTES.md")));
}, 600_000);

test("RN-05 a failing gate stops the release before anything is packaged", () => {
  const r = spawnSync(process.execPath, ["scripts/release.mjs", "--out", OUT2], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MC_RELEASE_GATE_CMD: 'node -e "process.exit(3)"' },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("RELEASE FAIL gate");
  const tgz = existsSync(OUT2) ? readdirSync(OUT2).filter((f) => f.endsWith(".tgz")) : [];
  expect(tgz).toHaveLength(0);
}, 30_000);
