import { describe, expect, it } from "vitest";
import type { Host, IngestOrigin, OsNotification } from "@mc/contracts";
import { createPlatform, exec, FakePlatform, NullPlatform } from "../src/index.js";
import type { FocusOptions, NativeWindow, PlatformEnv, ResolvedTarget } from "../src/types.js";
import { checkConformance } from "./conformance.js";

const OPTS: FocusOptions = { maximize: "never", foregroundStrategy: "plain", fromActivation: false };
const origin = {
  os: "linux", hookPid: 1, agent: { pid: 4242, name: "claude", startTime: "t" }, ancestry: [],
} as unknown as IngestOrigin;
const host = { kind: "unknown" } as unknown as Host;
const SAMPLE: OsNotification = { sessionId: "sess-1", title: "t", body: "b", urgency: "normal", tag: "x" };
const deadWindow: NativeWindow = { os: "linux", handle: "0xDEAD", pid: 1111, app: "FakeTerm", title: "dead" };
const deadPid = 999999;

describe("platform fake", () => {
  it("FK-01 createPlatform returns FakePlatform when MC_PLATFORM=fake", async () => {
    const env = { displayEnv: () => ({ MC_PLATFORM: "fake" }) } as unknown as PlatformEnv;
    const p = await createPlatform(env);
    expect(p).toBeInstanceOf(FakePlatform);
  });

  it("FK-02 fake records every call with method and args", async () => {
    const logged: string[] = [];
    const fake = new FakePlatform({}, (c) => logged.push(c.method));
    await fake.capabilities();
    await fake.processAlive(42, null);
    expect(fake.calls.map((c) => c.method)).toEqual(["capabilities", "processAlive"]);
    expect(fake.calls[1]?.args).toEqual([42, null]);
    expect(logged).toEqual(["capabilities", "processAlive"]);
  });

  it("FK-03 fake focus returns the scripted code with the matching status", async () => {
    const fake = new FakePlatform();
    const target = await fake.resolveTarget(origin, host);
    expect(await fake.focus(target, OPTS)).toMatchObject({ status: "ok", code: "focused" });
    fake.setScript({ focusResult: "focused_window_only" });
    expect(await fake.focus(target, OPTS)).toMatchObject({ status: "partial", code: "focused_window_only" });
    fake.setScript({ focusResult: "timeout" });
    expect(await fake.focus(target, OPTS)).toMatchObject({ status: "failed", code: "timeout" });
  });

  it("FK-04 fake click invokes the stored onClick with the session id", async () => {
    const fake = new FakePlatform();
    const got: (string | null)[] = [];
    await fake.notify(SAMPLE, (id) => got.push(id));
    fake.click("sess-1");
    expect(got).toEqual(["sess-1"]);
  });

  it("FK-05 fake foregroundWindow follows setScript", async () => {
    const fake = new FakePlatform();
    expect(await fake.foregroundWindow()).toBeNull();
    fake.setScript({ foregroundSessionWindow: "0xABC" });
    expect((await fake.foregroundWindow())?.handle).toBe("0xABC");
    fake.setScript({ foregroundSessionWindow: null });
    expect(await fake.foregroundWindow()).toBeNull();
  });

  it("FK-06 exec resolves timedOut and kills a process that outlives timeoutMs", async () => {
    const r = await exec(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("FK-07 NullPlatform focus returns failed/unsupported", async () => {
    const target: ResolvedTarget = { window: null, inner: null, capability: "none", reason: "no_window_found" };
    const r = await new NullPlatform().focus(target, OPTS);
    expect(r).toMatchObject({ status: "failed", code: "unsupported" });
  });

  it("FK-08 fake passes the conformance checks", async () => {
    const results = await checkConformance(
      async () => new FakePlatform({
        alivePids: new Set([process.pid]),
        deadHandles: new Set([deadWindow.handle]),
      }),
      { origin, host, deadWindow, deadPid },
    );
    expect(results).toHaveLength(5);
    for (const r of results) expect(r.ok, `${r.rule}: ${r.detail}`).toBe(true);
  });
});
