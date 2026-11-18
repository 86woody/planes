// TEST-PLAN 2.2, the milestone gate runner.
// Usage: node scripts/gate.mjs <m0..m5> [--gates <file>] [--reports <dir>]
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStage } from "./lib/run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RANK = { m0: 0, m1: 1, m2: 2, m3: 3, m4: 4, m5: 5 };

let gateName;
let gatesFile = path.join(ROOT, "scripts/gates.json");
let reportsDir = path.join(ROOT, ".gate/reports");
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--gates") gatesFile = path.resolve(argv[++i] ?? "");
  else if (argv[i] === "--reports") reportsDir = path.resolve(argv[++i] ?? "");
  else gateName = argv[i];
}
if (!(gateName in RANK)) {
  console.error("usage: node scripts/gate.mjs <m0..m5> [--gates <file>] [--reports <dir>]");
  process.exit(2);
}

const { stages } = JSON.parse(readFileSync(gatesFile, "utf8"));
const selected = stages.filter((s) => RANK[s.first] <= RANK[gateName]);

rmSync(reportsDir, { recursive: true, force: true });
mkdirSync(reportsDir, { recursive: true });
const gate = { name: gateName, root: ROOT, reportsDir };

// The one summary line a passing stage may show: audit counts, toolchain versions.
function summaryOf(tail) {
  const last = [...tail].reverse().find((l) => l.trim() !== "") ?? "";
  return /^(ids |node v)/.test(last) ? last.trim() : "";
}

let passed = 0;
for (const stage of selected) {
  const r = await runStage(stage, gate);
  const summary = r.pass ? summaryOf(r.tail) : "";
  console.log(`STAGE ${stage.name} ${r.pass ? "PASS" : "FAIL"} ${r.ms}ms${summary ? `  ${summary}` : ""}`);
  if (r.pass) {
    passed++;
  } else {
    for (const line of r.tail) console.log(`  | ${line}`);
    if (stage.name === "toolchain") break;
  }
}

const total = selected.length;
const ok = passed === total;
console.log(`GATE ${gateName} ${ok ? "PASS" : "FAIL"} ${passed}/${total}`);
process.exitCode = ok ? 0 : 1;
