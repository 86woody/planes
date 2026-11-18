// TEST-PLAN 2.4, the per-task acceptance check.
// Usage: node scripts/task-check.mjs T0xx
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, lastLines } from "./lib/run.mjs";
import { readReport } from "./lib/report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID_TITLE = /^([A-Z]+-\d{2})\s/;
const OS_DIR = "packages/platform/test/os/";

const task = process.argv[2];
if (!/^T\d{3}$/.test(task ?? "")) {
  console.error("usage: node scripts/task-check.mjs T0xx");
  process.exit(2);
}

const tasksMd = readFileSync(path.join(ROOT, "docs/TASKS.md"), "utf8");
if (!new RegExp(`^\\| ${task} \\|`, "m").test(tasksMd)) {
  console.log(`TASK ${task} UNKNOWN`);
  process.exit(2);
}

const registry = JSON.parse(readFileSync(path.join(ROOT, "scripts/test-ids.json"), "utf8")).ids;
const osName = { win32: "windows", darwin: "macos" }[process.platform] ?? "linux";

const all = Object.entries(registry).filter(([, e]) => e.task === task);
const mine = all.filter(([, e]) => e.os === "any" || e.os === osName);
const other = all.length - mine.length;
const suffix = other > 0 ? ` (os=${osName}, ${other} ids for other OSes not checked)` : "";

if (mine.length === 0) {
  console.log(`TASK ${task} PASS 0/0${suffix}`);
  process.exit(0);
}

// One vitest run for ordinary files, one for OS files (with MC_OS_TESTS=1), one Playwright run.
const vitestFiles = new Set();
const osFiles = new Set();
const pwFiles = new Set();
for (const [, e] of mine) {
  if (e.runner === "playwright") pwFiles.add(e.file);
  else if (e.file.startsWith(OS_DIR)) osFiles.add(e.file);
  else vitestFiles.add(e.file);
}

const outDir = path.join(ROOT, ".gate");
mkdirSync(outDir, { recursive: true });

const logs = [];
const tests = [];

async function runVitest(files, env, tag) {
  if (files.size === 0) return;
  const out = path.join(outDir, `task-${task}.${tag}.json`);
  rmSync(out, { force: true });
  const r = await runCommand(
    `vitest run ${[...files].join(" ")} --reporter=default --reporter=json --outputFile="${out}"`,
    { cwd: ROOT, env },
  );
  logs.push(r.output);
  tests.push(...readReport(out));
}

async function runPlaywright() {
  if (pwFiles.size === 0) return;
  const out = path.join(outDir, `task-${task}.playwright.json`);
  rmSync(out, { force: true });
  const r = await runCommand(`playwright test ${[...pwFiles].join(" ")} --reporter=line,json`, {
    cwd: ROOT,
    env: { PLAYWRIGHT_JSON_OUTPUT_NAME: out },
  });
  logs.push(r.output);
  tests.push(...readReport(out));
}

await runVitest(vitestFiles, {}, "vitest");
await runVitest(osFiles, { MC_OS_TESTS: "1" }, "vitest-os");
await runPlaywright();

const passedIds = new Set();
for (const t of tests) {
  const m = ID_TITLE.exec(t.title);
  if (m && t.status === "passed") passedIds.add(m[1]);
}
const missing = mine.map(([id]) => id).filter((id) => !passedIds.has(id));
const n = mine.length;

if (missing.length === 0) {
  console.log(`TASK ${task} PASS ${n}/${n}${suffix}`);
  process.exitCode = 0;
} else {
  for (const log of logs) for (const line of lastLines(log)) console.log(`  | ${line}`);
  console.log(`TASK ${task} FAIL ${n - missing.length}/${n} missing: ${missing.join(",")}${suffix}`);
  process.exitCode = 1;
}
