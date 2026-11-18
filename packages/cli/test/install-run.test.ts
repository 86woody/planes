import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { realRun } from "../src/installers/manifest.js";

// T101: on Windows realRun runs non-.exe commands (code.cmd, npm.cmd, pwsh) through cmd.exe /s /c "<line>".
// T104: the same contract on every OS, so the ID is never skipped (a .cmd on Windows, a shell script elsewhere).
describe("realRun", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mc run "));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("RR-01 a script in a path with a space runs and receives a quoted argument intact", async () => {
    let script: string;
    if (process.platform === "win32") {
      script = path.join(dir, "echo args.cmd");
      writeFileSync(script, "@echo off\r\necho [%~1][%~2]\r\n");
    } else {
      script = path.join(dir, "echo args.sh");
      writeFileSync(script, '#!/bin/sh\necho "[$1][$2]"\n');
      chmodSync(script, 0o755);
    }
    const r = await realRun(script, ["hello world", "x"], { timeoutMs: 15000 });
    expect(r.stderr.trim()).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("[hello world][x]");
  });
});
