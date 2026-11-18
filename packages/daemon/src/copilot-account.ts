// D-56 items 2 and 4: the Copilot account data behind DaemonInfo.copilot. Contract:
// docs/contracts/internal.md (copilot-account.ts row), docs/contracts/api.schema.json ($defs/CopilotAccount).
import type { CopilotAccount } from "@mc/contracts";
import { aiCreditsOf } from "@mc/core";
import type { Clock, DaemonDeps, Logger } from "./internal.js";
import type { CopilotAccountClient } from "./copilot-sdk-client.js";

const DEFAULT_REFRESH_MS = 300_000;
const SAMPLE_KEEP_MS = 7 * 24 * 3_600_000;
const MIN_FORECAST_SPAN_MS = 3_600_000;
const ERROR_MAX = 200;
const SECRET = /(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g;

type Quota = NonNullable<CopilotAccount["quota"]>;
type Sample = { t: number; used: number };

export interface CopilotAccountOptions {
  client: CopilotAccountClient;
  refreshMs?: number;
  onChange(): void;
}

export interface CopilotAccountService {
  start(): void;
  stop(): Promise<void>;
  current(): CopilotAccount | null;
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(SECRET, "<redacted>").slice(0, ERROR_MAX);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** The quota snapshot with a numeric entitlement; a key naming premium or credit wins. */
function pickSnapshot(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || !isRecord(result["quotaSnapshots"])) return null;
  const numeric = Object.entries(result["quotaSnapshots"])
    .filter(([, v]) => isRecord(v) && typeof v["entitlementRequests"] === "number");
  const preferred = numeric.find(([k]) => /premium|credit/i.test(k)) ?? numeric[0];
  return preferred ? (preferred[1] as Record<string, unknown>) : null;
}

function quotaFrom(snap: Record<string, unknown>): Quota {
  const entitlement = snap["entitlementRequests"] as number;
  return {
    // The SDK reports -1 for an unlimited entitlement; the contract's minimum is 0, so that is null.
    entitlement: entitlement < 0 ? null : entitlement,
    used: typeof snap["usedRequests"] === "number" ? snap["usedRequests"] : null,
    remainingPct: typeof snap["remainingPercentage"] === "number" ? snap["remainingPercentage"] : null,
    resetDate: typeof snap["resetDate"] === "string" ? snap["resetDate"] : null,
    unlimited: typeof snap["isUnlimitedEntitlement"] === "boolean" ? snap["isUnlimitedEntitlement"] : null,
  };
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function createCopilotAccount(
  deps: Pick<DaemonDeps, "clock" | "log" | "sessions">,
  opts: CopilotAccountOptions,
): CopilotAccountService {
  const { client, onChange } = opts;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  const clock: Clock = deps.clock;
  const log: Logger = deps.log;

  let begun = false;
  let started = false;
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: CopilotAccount | null = null;
  let runtimeVersion: string | null = null;
  let planTier: string | null = null;
  let quota: Quota | null = null;
  let samples: Sample[] = [];

  const nanoToday = (now: number): number => {
    let total = 0;
    for (const s of deps.sessions.list()) {
      const nano = s.telemetry?.credits.nanoAiu;
      if (typeof nano === "number" && sameLocalDay(Date.parse(s.updatedAt), now)) total += nano;
    }
    return total;
  };

  const forecast = (now: number): number | null => {
    if (quota === null || quota.used === null || quota.resetDate === null) return null;
    if (quota.entitlement === null || quota.entitlement <= 0) return null;
    const resetMs = Date.parse(quota.resetDate);
    if (Number.isNaN(resetMs) || samples.length < 2) return null;
    const first = samples[0];
    const latest = samples[samples.length - 1];
    if (first === undefined || latest === undefined) return null;
    const span = latest.t - first.t;
    if (span < MIN_FORECAST_SPAN_MS) return null;
    const rate = (latest.used - first.used) / span;
    const msUntilReset = Math.max(0, resetMs - now);
    return (100 * (quota.used + rate * msUntilReset)) / quota.entitlement;
  };

  const refresh = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    const now = clock.now();
    let error: string | null = null;
    try {
      if (!started) {
        try {
          await client.start();
          started = true;
        } catch (err) {
          error = messageOf(err);
        }
      }
      if (started) {
        try {
          runtimeVersion = (await client.status()).runtimeVersion;
        } catch (err) {
          error ??= messageOf(err);
        }
        try {
          const result = await client.quota();
          const snap = pickSnapshot(result);
          const tier = isRecord(result) ? result["planTier"] : undefined;
          planTier = typeof tier === "string" ? tier : null;
          if (snap !== null) {
            quota = quotaFrom(snap);
            if (quota.used !== null) {
              samples = samples.filter((s) => now - s.t < SAMPLE_KEEP_MS);
              samples.push({ t: now, used: quota.used });
            }
          }
        } catch (err) {
          error ??= messageOf(err);
        }
      }
      const nanoAiuToday = nanoToday(now);
      const next: CopilotAccount = {
        updatedAt: new Date(now).toISOString(),
        runtimeVersion,
        planTier,
        quota,
        nanoAiuToday,
        aiCreditsToday: aiCreditsOf(nanoAiuToday),
        forecastPct: forecast(now),
        error,
      };
      const prev = last;
      last = next;
      // updatedAt moves on every refresh; only a change in the data is a change for the UI.
      const key = (c: CopilotAccount): string => JSON.stringify({ ...c, updatedAt: "" });
      if (prev === null || key(prev) !== key(next)) onChange();
    } catch (err) {
      log.error({ err: messageOf(err) }, "copilot account refresh failed");
    } finally {
      busy = false;
    }
  };

  return {
    start() {
      if (stopped || timer !== null) return;
      begun = true;
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (begun) await client.stop();
    },
    current() {
      return last;
    },
  };
}
