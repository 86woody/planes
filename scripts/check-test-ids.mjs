// TEST-PLAN 2.3, the audit.
// Usage: node scripts/check-test-ids.mjs --gate <mN> [--reports <dir>]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readReportDir } from "./lib/report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RANK = { m0: 0, m1: 1, m2: 2, m3: 3, m4: 4, m5: 5 };
const ID_TITLE = /^([A-Z]+-\d{2})\s/;

function parseArgs(argv) {
  const opts = { gate: undefined, reports: path.join(ROOT, ".gate/reports") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gate") opts.gate = argv[++i];
    else if (argv[i] === "--reports") opts.reports = path.resolve(argv[++i] ?? "");
  }
  return opts;
}

const { gate, reports } = parseArgs(process.argv.slice(2));
if (!(gate in RANK)) {
  console.error("usage: node scripts/check-test-ids.mjs --gate <m0..m5> [--reports <dir>]");
  process.exit(2);
}

const osName = { win32: "windows", darwin: "macos" }[process.platform] ?? "linux";
const registry = JSON.parse(readFileSync(path.join(ROOT, "scripts/test-ids.json"), "utf8")).ids;

const required = Object.keys(registry).filter((id) => {
  const e = registry[id];
  return RANK[e.milestone] <= RANK[gate] && (e.os === "any" || e.os === osName);
});

const tests = readReportDir(reports);
const passed = new Set();
const unknown = new Set();
let skipped = 0;
for (const t of tests) {
  if (t.status === "skipped") skipped++;
  const m = ID_TITLE.exec(t.title);
  if (!m) continue;
  if (!(m[1] in registry)) unknown.add(m[1]);
  else if (t.status === "passed") passed.add(m[1]);
}

const missing = required.filter((id) => !passed.has(id));
const found = required.length - missing.length;
console.log(`ids ${found}/${required.length} (os=${osName}), skipped ${skipped}`);
if (missing.length > 0) console.log(`missing: ${missing.join(",")}`);
if (unknown.size > 0) console.log(`unknown: ${[...unknown].join(",")}`);
process.exitCode = missing.length === 0 && unknown.size === 0 && skipped === 0 ? 0 : 1;
