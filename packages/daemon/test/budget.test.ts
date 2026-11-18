import { processStartTime } from "@mc/platform";
import { describe, expect, it } from "vitest";
import {
  envelopeFor,
  exited,
  freshHome,
  postEnvelope,
  processRssBytes,
  removeHome,
  setFakeProcessEnv,
  spawnDaemonProcess,
} from "./integration/support/harness.js";

const SESSIONS = 20;
const EVENTS_PER_SESSION = 100;
const BATCH = 150; // api.md 4: ingest is limited to 200 per second.
const RSS_LIMIT = 150 * 1024 * 1024;

describe("resource budget", () => {
  it("BG-01 20 sessions and 2000 events keep RSS under 150 MB", async () => {
    const home = freshHome();
    const restoreEnv = setFakeProcessEnv();
    // The daemon runs as its own process, so its RSS is measured on its own. Measured in-process,
    // the vitest worker alone is about 100 MB before the daemon starts.
    const d = await spawnDaemonProcess(home);
    try {
      // Agents are this test process, so liveness keeps every session alive while events arrive.
      const startTime = await processStartTime(process.pid);
      const target = { port: d.port, token: d.token, url: d.url, stop: async () => undefined, home };
      let sent = 0;
      for (let s = 0; s < SESSIONS; s++) {
        for (let e = 0; e < EVENTS_PER_SESSION; e++) {
          const event = e === 0 ? "SessionStart" : "PostToolUse";
          const env = envelopeFor({
            event,
            nativeSessionId: `bg01-${s}`,
            agentPid: process.pid,
            agentStartTime: startTime,
          });
          const res = await postEnvelope(target, env);
          expect(res.status).toBe(202);
          sent += 1;
          if (sent % BATCH === 0) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      expect(sent).toBe(SESSIONS * EVENTS_PER_SESSION);

      const rss = processRssBytes(d.pid);
      expect(rss).toBeGreaterThan(0);
      expect(rss).toBeLessThan(RSS_LIMIT);
    } finally {
      d.child.kill();
      await exited(d.child);
      restoreEnv();
      removeHome(home);
    }
  }, 90_000);
});
