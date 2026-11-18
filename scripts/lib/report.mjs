// Reads vitest and Playwright JSON reports into {title, status} lists.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function normaliseStatus(status) {
  if (status === "passed") return "passed";
  if (status === "skipped" || status === "pending" || status === "todo" || status === "disabled") {
    return "skipped";
  }
  return "failed"; // failed, timedOut, interrupted, or anything unknown
}

function fromVitest(json) {
  const out = [];
  for (const file of json.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      out.push({ title: a.title, status: normaliseStatus(a.status) });
    }
  }
  return out;
}

function walkPlaywright(suite, out) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const results = t.results ?? [];
      const last = results.length > 0 ? results[results.length - 1].status : "skipped";
      const status = t.status === "skipped" ? "skipped" : normaliseStatus(last);
      out.push({ title: spec.title, status });
    }
  }
  for (const child of suite.suites ?? []) walkPlaywright(child, out);
}

function fromPlaywright(json) {
  const out = [];
  for (const suite of json.suites ?? []) walkPlaywright(suite, out);
  return out;
}

// Detects the format from its shape. Unknown shapes yield no tests.
export function reportTests(json) {
  if (Array.isArray(json.testResults)) return fromVitest(json);
  if (Array.isArray(json.suites)) return fromPlaywright(json);
  return [];
}

// A missing or unreadable report yields no tests, so its IDs show as missing.
export function readReport(file) {
  if (!existsSync(file)) return [];
  try {
    return reportTests(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

export function readReportDir(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".json")) out.push(...readReport(path.join(dir, name)));
  }
  return out;
}
