import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config, OsNotification } from "@mc/contracts";
import { exec } from "../../src/exec.js";
import { createNotify } from "../../src/macos/notify.js";
import type { PlatformEnv } from "../../src/types.js";

const enabled = process.platform === "darwin" && process.env.MC_OS_TESTS === "1";

describe.skipIf(!enabled)("macos notify (OS)", () => {
  it("MO-05 notify through the osascript backend returns a handle and does not throw", async () => {
    // Hide homebrew helpers so detection picks the osascript backend.
    const savedPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      const home = mkdtempSync(join(tmpdir(), "mc-macos-notify-"));
      const env = {
        stateDir: home,
        config: {} as Config,
        repoRoot: home,
        displayEnv: () => process.env,
      } as PlatformEnv;
      const notifier = createNotify({ exec, env });
      expect(notifier.backend).toBe("osascript");
      const n: OsNotification = {
        sessionId: null,
        title: "mission-control test",
        body: "MO-05",
        urgency: "low",
        tag: "mc-test-mo-05",
      };
      const handle = await notifier.notify(n, () => {});
      expect(handle).not.toBeNull();
      await notifier.withdraw(handle!);
      await notifier.dispose();
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
