import { processStartTime } from "@mc/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  envelopeFor,
  exited,
  findSession,
  freshHome,
  getState,
  postEnvelope,
  rawHookInput,
  removeHome,
  runHook,
  setFakeProcessEnv,
  spawnDummyAgent,
  startTestDaemon,
  waitFor,
  type RunningDaemon,
} from "./support/harness.js";

describe("persistence across daemon restarts (real processes)", () => {
  let home = "";
  let restoreEnv: () => void = () => undefined;
  let running: RunningDaemon | null = null;

  beforeEach(() => {
    home = freshHome();
    restoreEnv = setFakeProcessEnv();
  });

  afterEach(async () => {
    if (running) await running.stop();
    running = null;
    restoreEnv();
    removeHome(home);
  });

  it("PS-04 restart keeps sessions and callsigns", async () => {
    running = await startTestDaemon(home);
    for (const sid of ["ps04-a", "ps04-b"]) {
      const r = await runHook(["claude-code"], rawHookInput("SessionStart", sid, { source: "startup" }), home);
      expect(r.code).toBe(0);
    }
    const before = await waitFor(
      () => getState(running!),
      (s) => s.sessions.length === 2,
      3000,
    );
    const expected = before.sessions.map((s) => ({ id: s.id, callsign: s.callsign })).sort((a, b) => a.id.localeCompare(b.id));
    expect(expected).toHaveLength(2);

    await running.stop();
    running = await startTestDaemon(home);

    const after = (await getState(running)).sessions.map((s) => ({ id: s.id, callsign: s.callsign })).sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(expected);
  });

  it("PS-05 restart re-checks liveness: a session whose pid died while stopped is ended after start", async () => {
    running = await startTestDaemon(home);
    const agent = spawnDummyAgent();
    try {
      const pid = agent.pid;
      if (pid === undefined) throw new Error("dummy agent did not start");
      const startTime = await processStartTime(pid);
      const posted = await postEnvelope(
        running,
        envelopeFor({ event: "SessionStart", nativeSessionId: "ps05-session", agentPid: pid, agentStartTime: startTime }),
      );
      expect(posted.status).toBe(202);
      await running.stop();
      running = null;

      agent.kill();
      await exited(agent);

      running = await startTestDaemon(home);
      const session = await waitFor(() => findSession(running!, "ps05-session"), (v) => v?.state === "ended", 10_000);
      expect(session?.state).toBe("ended");
    } finally {
      agent.kill();
    }
  });
});
