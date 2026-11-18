// One version source: the root package.json. `check` verifies every manifest matches;
// `set <v>` writes it into every manifest by text replacement.
// Usage: node scripts/version.mjs set <x.y.z> | check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: node scripts/version.mjs set <x.y.z> | check";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const VERSION_FIELD = /"version"\s*:\s*"[^"]*"/;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.MC_VERSION_ROOT
  ? path.resolve(process.env.MC_VERSION_ROOT)
  : path.join(here, "..");

function manifestPaths() {
  const files = [path.join(root, "package.json")];
  const packagesDir = path.join(root, "packages");
  if (fs.existsSync(packagesDir)) {
    const dirs = fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(packagesDir, d.name, "package.json"))
      .filter((f) => fs.existsSync(f))
      .sort();
    files.push(...dirs);
  }
  return files;
}

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

function versionOf(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return typeof parsed.version === "string" ? parsed.version : "none";
}

function check() {
  const files = manifestPaths();
  const rootVersion = versionOf(files[0]);
  let bad = 0;
  for (const file of files) {
    const v = versionOf(file);
    if (v !== rootVersion) {
      bad += 1;
      process.stderr.write(`version mismatch: ${rel(file)} has ${v}, root has ${rootVersion}\n`);
    }
  }
  if (bad > 0) return 1;
  process.stdout.write(`version ${rootVersion} ok (${files.length} manifests)\n`);
  return 0;
}

function set(v) {
  const files = manifestPaths();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(VERSION_FIELD, `"version": "${v}"`));
  }
  process.stdout.write(`version set to ${v} (${files.length} manifests)\n`);
  return 0;
}

function main(args) {
  if (args.length === 1 && args[0] === "check") return check();
  if (args.length === 2 && args[0] === "set" && SEMVER.test(args[1])) return set(args[1]);
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
