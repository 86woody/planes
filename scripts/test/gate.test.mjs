import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const AUDIT = path.join(ROOT, "scripts/check-test-ids.mjs");
const GATE = path.join(ROOT, "scripts/gate.mjs");
const FIXTURE = path.join(HERE, "fixtures/reports/m0-pass.json");
const SLOW = 120_000;

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "gate-test-"));
}

// Copies the all-passing m0 fixture into a temp dir, after an optional edit of its tests.
function reportDirWith(mutate) {
  const dir = tempDir();
  const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
  mutate(json.testResults[0].assertionResults);
  writeFileSync(path.join(dir, "m0.json"), JSON.stringify(json));
  return dir;
}

function runAudit(dir) {
  const r = spawnSync(process.execPath, [AUDIT, "--gate", "m0", "--reports", dir], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function lastLine(text) {
  return text.trim().split(/\r?\n/).at(-1);
}

test("GT-01 audit passes when every required id passed", () => {
  const dir = reportDirWith(() => {});
  try {
    const r = runAudit(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ids 22/22");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GT-02 audit fails and lists a missing id", () => {
  const dir = reportDirWith((results) => {
    results.splice(results.findIndex((t) => t.title.startsWith("CT-01 ")), 1);
  });
  try {
    const r = runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing: CT-01");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GT-03 audit fails on a skipped test", () => {
  const dir = reportDirWith((results) => {
    results.find((t) => t.title.startsWith("GT-06 ")).status = "skipped";
  });
  try {
    const r = runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("skipped 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GT-04 audit fails on an unknown id-shaped title", () => {
  const dir = reportDirWith((results) => {
    results.push({ title: "ZZ-99 not in the registry", status: "passed" });
  });
  try {
    const r = runAudit(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown: ZZ-99");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GT-05 gate output ends with GATE <name> PASS n/n and exits 0 for a gates.json of two passing cmd stages", () => {
  const dir = tempDir();
  try {
    const gatesFile = path.join(dir, "gates.json");
    writeFileSync(
      gatesFile,
      JSON.stringify({
        stages: [
          { name: "first", kind: "cmd", cmd: "node -e \"process.exit(0)\"", first: "m0" },
          { name: "second", kind: "cmd", cmd: "node -e \"process.exit(0)\"", first: "m0" },
        ],
      }),
    );
    const r = spawnSync(
      process.execPath,
      [GATE, "m0", "--gates", gatesFile, "--reports", path.join(dir, "reports")],
      { encoding: "utf8", timeout: SLOW },
    );
    expect(r.status).toBe(0);
    expect(lastLine(r.stdout)).toBe("GATE m0 PASS 2/2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, SLOW);

test("GT-06 gate continues after a failing stage and exits 1 with FAIL 1/2", () => {
  const dir = tempDir();
  try {
    const gatesFile = path.join(dir, "gates.json");
    writeFileSync(
      gatesFile,
      JSON.stringify({
        stages: [
          { name: "failing", kind: "cmd", cmd: "node -e \"process.exit(1)\"", first: "m0" },
          { name: "passing", kind: "cmd", cmd: "node -e \"process.exit(0)\"", first: "m0" },
        ],
      }),
    );
    const r = spawnSync(
      process.execPath,
      [GATE, "m0", "--gates", gatesFile, "--reports", path.join(dir, "reports")],
      { encoding: "utf8", timeout: SLOW },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("STAGE failing FAIL");
    expect(r.stdout).toContain("STAGE passing PASS");
    expect(lastLine(r.stdout)).toBe("GATE m0 FAIL 1/2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, SLOW);
