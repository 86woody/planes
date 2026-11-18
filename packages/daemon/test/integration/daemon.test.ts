import { processStartTime } from "@mc/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlreadyRunning, startDaemon } from "../../src/main.js";
import {
  envelopeFor,
  exited,
  fakeCalls,
  findSession,
  freshHome,
  pinHookToClosedPort,
  postEnvelope,
  rawHookInput,
  removeHome,
  runHook,
  setFakeProcessEnv,
  spawnDummyAgent,
  startTestDaemon,
  testEnv,
  waitFor,
  type RunningDaemon,
} from "./support/harness.js";

describe("daemon integration (real daemon, real mc-hook)", () => {
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

  it("IT-01 a raw SessionStart piped through mc-hook appears in GET /api/state within 1 s", async () => {
    running = await startTestDaemon(home);
    const sid = "it01-session";
    const r = await runHook(["claude-code"], rawHookInput("SessionStart", sid, { source: "startup" }), home);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const started = Date.now();
    const found = await waitFor(() => findSession(running!, sid), (v) => v !== undefined, 1000);
    expect(found?.nativeId).toBe(sid);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("IT-02 PermissionRequest through mc-hook produces needs_permission and one fake notify call", async () => {
    running = await startTestDaemon(home);
    const sid = "it02-session";
    const r = await runHook(
      ["claude-code"],
      rawHookInput("PermissionRequest", sid, { tool_name: "Bash", tool_input: { command: "npm test" } }),
      home,
    );
    expect(r.code).toBe(0);
    const session = await waitFor(() => findSession(running!, sid), (v) => v?.state === "needs_permission", 5000);
    expect(session?.state).toBe("needs_permission");
    const notified = await waitFor(
      () => fakeCalls(running!),
      (c) => c.some((x) => x.method === "notify"),
      5000,
    );
    expect(notified.filter((x) => x.method === "notify")).toHaveLength(1);
    // The notifier coalesces on a 1 s tick; a second notify for the same entry would show up here.
    await new Promise((res) => setTimeout(res, 1500));
    const later = await fakeCalls(running!);
    expect(later.filter((x) => x.method === "notify")).toHaveLength(1);
  });

  it("IT-03 hook events while the daemon is stopped are spooled and ingested on the next start", async () => {
    await pinHookToClosedPort(home);
    const sid = "it03-session";

    const first = await startTestDaemon(home);
    await first.stop();

    const r = await runHook(["claude-code"], rawHookInput("SessionStart", sid, { source: "startup" }), home);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");

    running = await startTestDaemon(home);
    const found = await findSession(running, sid);
    expect(found?.nativeId).toBe(sid);
  });

  it("IT-04 a second startDaemon on the same MC_HOME throws AlreadyRunning", async () => {
    running = await startTestDaemon(home);
    const err = await startDaemon({ env: testEnv(home), foreground: false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlreadyRunning);
    expect((err as AlreadyRunning).pid).toBe(process.pid);
    expect((err as AlreadyRunning).port).toBe(running.port);
  });

  it("IT-05 a session whose agent pid exits becomes ended within 10 s", async () => {
    running = await startTestDaemon(home);
    const agent = spawnDummyAgent();
    try {
      const pid = agent.pid;
      if (pid === undefined) throw new Error("dummy agent did not start");
      const startTime = await processStartTime(pid);
      const env = envelopeFor({ event: "SessionStart", nativeSessionId: "it05-session", agentPid: pid, agentStartTime: startTime });
      const posted = await postEnvelope(running, env);
      expect(posted.status).toBe(202);
      const before = await findSession(running, "it05-session");
      expect(before?.state).not.toBe("ended");

      agent.kill();
      await exited(agent);
      const ended = await waitFor(() => findSession(running!, "it05-session"), (v) => v?.state === "ended", 10_000);
      expect(ended?.state).toBe("ended");
    } finally {
      agent.kill();
    }
  });

  it("IT-06 restore through the API calls the fake platform focus and acknowledges attention", async () => {
    running = await startTestDaemon(home);
    const sid = "it06-session";
    await runHook(
      ["claude-code"],
      rawHookInput("PermissionRequest", sid, { tool_name: "Bash", tool_input: { command: "npm test" } }),
      home,
    );
    const session = await waitFor(() => findSession(running!, sid), (v) => v?.state === "needs_permission", 5000);
    if (!session) throw new Error("session was not created");

    const res = await fetch(running.url(`/api/sessions/${encodeURIComponent(session.id)}/restore`), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${running.token}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { status: string }; session: { attention: { acknowledged: boolean } } };
    expect(body.result.status).toBe("ok");
    expect((await fakeCalls(running)).some((c) => c.method === "focus")).toBe(true);
    expect(body.session.attention.acknowledged).toBe(true);
  });
});
