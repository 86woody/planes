#!/usr/bin/env node
// Cut a release: gate, package, copy the notes. Usage: node scripts/release.mjs [--skip-gate] [--out <dir>]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/release.mjs [--skip-gate] [--out <dir>]";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function usage() {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

function parseArgs(argv) {
  let skipGate = false;
  let out = join(ROOT, "release");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-gate") skipGate = true;
    else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) usage();
      out = resolve(ROOT, value);
      i++;
    } else usage();
  }
  return { skipGate, out };
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

const { skipGate, out } = parseArgs(process.argv.slice(2));

if (!skipGate) {
  const gateCmd = process.env.MC_RELEASE_GATE_CMD || "npm run gate";
  const gate = spawnSync(gateCmd, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (gate.error || gate.status !== 0) fail("RELEASE FAIL gate");
}

mkdirSync(out, { recursive: true });

const pkg = spawnSync(process.execPath, [join(ROOT, "scripts", "package.mjs"), "--out", out], {
  cwd: ROOT,
  stdio: "inherit",
});
if (pkg.error || pkg.status !== 0) fail("RELEASE FAIL package");

const notesSource = join(ROOT, "RELEASE-NOTES.md");
const firstLine = readFileSync(notesSource, "utf8").split(/\r?\n/, 1)[0];
if (firstLine !== `# mission-control-desktop ${VERSION}`) fail("RELEASE FAIL notes version");
copyFileSync(notesSource, join(out, "RELEASE-NOTES.md"));

for (const name of [
  `mission-control-desktop-${VERSION}.tgz`,
  `vscode-bridge-${VERSION}.vsix`,
  "RELEASE-NOTES.md",
]) {
  if (!existsSync(join(out, name))) fail(`RELEASE FAIL missing ${name}`);
}

process.stdout.write(`RELEASE ${VERSION} ${out}\n`);
process.exit(0);
