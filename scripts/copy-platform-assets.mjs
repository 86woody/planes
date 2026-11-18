// Copies the macOS helper scripts from the platform source into its dist folder.
// Usage: node scripts/copy-platform-assets.mjs [platformPackageDir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, "..", "packages", "platform");

const src = path.join(dir, "src", "macos", "scripts");
const dest = path.join(dir, "dist", "macos", "scripts");

if (!fs.existsSync(src)) {
  process.stderr.write(`copy-platform-assets: missing ${src}\n`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const files = fs.readdirSync(src).filter((name) => fs.statSync(path.join(src, name)).isFile());
for (const name of files) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
}

process.stdout.write(`copied ${files.length} files to ${dest}\n`);
