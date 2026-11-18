import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exec } from "../../src/exec.js";
import { buildToastXml, toastTag, toastUri } from "../../src/windows/notify.js";
import { createToastHost, spawnToastHost } from "../../src/windows/toast-host.js";

// Real toasts and registry writes: Windows only, and only when MC_OS_TESTS=1 is set.
const enabled = process.platform === "win32" && process.env.MC_OS_TESTS === "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "..", "src", "windows", "ps", "toast-host.ps1");
const TEST_AUMID = "WoodyDeus.MissionControl.Test";
const TEST_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${TEST_AUMID}`;

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

describe.runIf(enabled)("windows notify (OS)", () => {
  it("WO-06 a shown toast appears in History.GetHistory within 2 s and withdraw removes it", async () => {
    const reg = await exec("reg.exe", [
      "add", TEST_KEY, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Mission Control Test", "/f",
    ]);
    expect(reg.code).toBe(0);
    const host = createToastHost(spawnToastHost(scriptPath));
    try {
      const tag = `mc-test-${randomBytes(4).toString("hex")}`;
      const hashed = toastTag(tag);
      const xml = buildToastXml(
        { sessionId: null, title: "MC test", body: "WO-06 · automated", urgency: "low", tag },
        { uri: toastUri(null), silent: true },
      );
      const shown = await host.request({ op: "show", aumid: TEST_AUMID, tag: hashed, group: "mc", xml });
      expect(shown?.ok).toBe(true);

      const inHistory = async (): Promise<boolean> => {
        const h = await host.request({ op: "history", aumid: TEST_AUMID });
        return h?.ok === true && (h.tags ?? []).includes(hashed);
      };
      expect(await waitFor(inHistory, 2000)).toBe(true);

      const removed = await host.request({ op: "remove", aumid: TEST_AUMID, tag: hashed, group: "mc" });
      expect(removed?.ok).toBe(true);
      expect(await waitFor(async () => !(await inHistory()), 2000)).toBe(true);
    } finally {
      host.dispose();
      await exec("reg.exe", ["delete", TEST_KEY, "/f"]);
    }
  }, 30000);
});
