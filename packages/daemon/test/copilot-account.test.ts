import type { Session, WsServerMessage } from "@mc/contracts";
import { validateWsServerMessage } from "@mc/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCopilotAccount } from "../src/copilot-account.js";
import type { CopilotAccountClient } from "../src/copilot-sdk-client.js";
import { daemonInfo } from "../src/routes/api.js";
import type { DaemonDeps } from "../src/internal.js";
import { makeDeps, type TestDeps } from "./support/deps.js";

// Fake client and fake timers only: the real SDK is never loaded here.
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);

interface FakeState {
  quota: unknown;
  failQuota: string | null;
  starts: number;
  statuses: number;
  stops: number;
}

function quotaResult(used: number): unknown {
  return {
    quotaSnapshots: {
      chat: {
        isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 0,
        usageAllowedWithExhaustedQuota: true, remainingPercentage: 100, overage: 0,
        overageAllowedWithExhaustedQuota: false,
      },
      premium_interactions: {
        isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: used,
        usageAllowedWithExhaustedQuota: false, remainingPercentage: 60, overage: 0,
        overageAllowedWithExhaustedQuota: false, resetDate: "2026-12-01T00:00:00Z",
      },
    },
  };
}

function fakeClient(used = 120): { client: CopilotAccountClient; state: FakeState } {
  const state: FakeState = { quota: quotaResult(used), failQuota: null, starts: 0, statuses: 0, stops: 0 };
  const client: CopilotAccountClient = {
    async start() { state.starts++; },
    async status() {
      state.statuses++;
      return { runtimeVersion: "1.0.112" };
    },
    async quota() {
      if (state.failQuota !== null) throw new Error(state.failQuota);
      return state.quota;
    },
    async stop() { state.stops++; },
  };
  return { client, state };
}

function session(id: string, updatedAt: number, nanoAiu: number | null): Session {
  return {
    id: `copilot-cli:${id}`,
    updatedAt: new Date(updatedAt).toISOString(),
    telemetry: nanoAiu === null ? null : { credits: { nanoAiu, aiCredits: null } },
  } as unknown as Session;
}

let t: TestDeps;

beforeEach(async () => {
  vi.useFakeTimers();
  t = await makeDeps(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  await t.dispose();
});

/** Advances the manual clock and the fake timers together, one 5-minute refresh at a time. */
async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 300_000) {
    t.clock.t += 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
  }
}

function service(client: CopilotAccountClient, onChange = (): void => undefined, sessions = t.deps.sessions) {
  return createCopilotAccount(
    { clock: t.deps.clock, log: t.deps.log, sessions },
    { client, refreshMs: 300_000, onChange },
  );
}

describe("T114 copilot account service", () => {
  it("TA-01 a healthy fake maps quota and validates as daemon.update", async () => {
    const { client } = fakeClient(120);
    const svc = service(client);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);

    const account = svc.current();
    expect(account).not.toBeNull();
    expect(account?.runtimeVersion).toBe("1.0.112");
    expect(account?.quota).toEqual({
      entitlement: 300, used: 120, remainingPct: 60, resetDate: "2026-12-01T00:00:00Z", unlimited: false,
    });
    expect(account?.error).toBeNull();

    const deps = { ...t.deps, copilot: svc } as DaemonDeps;
    const info = daemonInfo(deps, 4321);
    const msg = {
      type: "daemon.update",
      seq: 1,
      daemon: info,
      capabilities: await t.deps.platform.capabilities(),
    };
    const v = validateWsServerMessage(msg as WsServerMessage);
    expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
    await svc.stop();
  });

  it("TA-02 nanoAiuToday sums only sessions updated today; aiCreditsToday is that / 1e9 (D-61)", async () => {
    const { client } = fakeClient();
    const sessions = {
      list: () => [
        session("a", T0 - 60_000, 1000),
        session("b", T0 - 2 * 60_000, 2500),
        session("c", T0 - 36 * HOUR, 9999),
        session("d", T0 - 60_000, null),
      ],
    } as unknown as DaemonDeps["sessions"];
    const svc = service(client, undefined, sessions);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.current()?.nanoAiuToday).toBe(3500);
    expect(svc.current()?.aiCreditsToday).toBe(3500 / 1e9);
    await svc.stop();
  });

  it("TA-03 forecast is null with one sample and a number after two samples 2 h apart", async () => {
    const { client, state } = fakeClient(120);
    const svc = service(client);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.current()?.forecastPct).toBeNull();

    state.quota = quotaResult(150);
    await tick(2 * HOUR);
    const forecast = svc.current()?.forecastPct;
    expect(typeof forecast).toBe("number");

    const rate = (150 - 120) / (2 * HOUR);
    const msUntilReset = Date.parse("2026-12-01T00:00:00Z") - (T0 + 2 * HOUR);
    expect(forecast).toBeCloseTo((100 * (150 + rate * msUntilReset)) / 300, 6);
    await svc.stop();
  });

  it("TA-04 a failing quota sets error, redacts the token and keeps the last quota", async () => {
    const { client, state } = fakeClient(120);
    const svc = service(client);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = svc.current()?.quota;
    expect(before?.used).toBe(120);

    state.failQuota = "quota denied for gho_abc123 on this account";
    await tick(300_000);
    const after = svc.current();
    expect(after?.error).toContain("<redacted>");
    expect(after?.error).not.toContain("gho_abc123");
    expect(after?.quota).toEqual(before);
    await svc.stop();
  });

  it("TA-05 onChange fires for a change and not for an equal refresh; stop stops the client", async () => {
    const { client, state } = fakeClient(120);
    const onChange = vi.fn();
    const svc = service(client, onChange);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);

    // One refresh 5 min later with identical data: forecast is still null (under 1 h of samples).
    await tick(300_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    state.quota = quotaResult(130);
    await tick(300_000);
    expect(onChange).toHaveBeenCalledTimes(2);

    await svc.stop();
    expect(state.stops).toBe(1);
    const statusAfterStop = state.statuses;
    await tick(600_000);
    expect(state.statuses).toBe(statusAfterStop);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
