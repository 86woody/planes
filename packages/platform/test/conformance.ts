import { describe, expect, it } from "vitest";
import type { Host, IngestOrigin, OsNotification } from "@mc/contracts";
import type {
  FocusOptions, NativeWindow, PlatformAdapter, ResolvedTarget,
} from "../src/types.js";

export interface ConformanceFixtures {
  origin: IngestOrigin;
  host: Host;
  deadWindow: NativeWindow;
  deadPid: number;
}

export interface ConformanceResult { rule: string; ok: boolean; detail: string }

const OPTS: FocusOptions = { maximize: "never", foregroundStrategy: "plain", fromActivation: false };
const SAMPLE: OsNotification = {
  sessionId: null, title: "MISSION CONTROL CONFORMANCE", body: "conformance check", urgency: "low", tag: "mc-conformance",
};

const RULES: { rule: string; description: string }[] = [
  { rule: "PA-01", description: "no method throws or rejects" },
  { rule: "PA-02", description: "focus on a target without a window returns failed/unsupported" },
  { rule: "PA-04", description: "focus on a window that no longer exists returns failed/not_found" },
  { rule: "PA-07", description: "notify returns within 2000 ms (6000 ms on the first call)" },
  { rule: "PA-09", description: "processAlive of a dead pid is false and of a live pid is true" },
];

// PA-05 is not here: it needs an injected slow Exec, so each OS unit file tests it.
async function runRule(rule: string, make: () => Promise<PlatformAdapter>, f: ConformanceFixtures): Promise<ConformanceResult> {
  const adapter = await make();
  try {
    switch (rule) {
      case "PA-01": {
        const failures: string[] = [];
        const attempts: [string, () => Promise<unknown>][] = [
          ["capabilities", () => adapter.capabilities()],
          ["resolveTarget", () => adapter.resolveTarget(f.origin, f.host)],
          ["windowExists", () => adapter.windowExists(f.deadWindow)],
          ["foregroundWindow", () => adapter.foregroundWindow()],
          ["listWindows", () => adapter.listWindows(["fake"])],
          ["focus", () => adapter.focus({ window: f.deadWindow, inner: null, capability: "full", reason: null }, OPTS)],
          ["notify", () => adapter.notify(SAMPLE, () => {})],
          ["withdraw", () => adapter.withdraw({ id: "conformance-none" })],
          ["processAlive", () => adapter.processAlive(f.deadPid, null)],
        ];
        for (const [name, call] of attempts) {
          try {
            await call();
          } catch (err) {
            failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { rule, ok: failures.length === 0, detail: failures.join("; ") || "no method threw" };
      }
      case "PA-02": {
        const target: ResolvedTarget = { window: null, inner: null, capability: "none", reason: "no_window_found" };
        const r = await adapter.focus(target, OPTS);
        const ok = r.status === "failed" && r.code === "unsupported";
        return { rule, ok, detail: `status=${r.status} code=${r.code}` };
      }
      case "PA-04": {
        const target: ResolvedTarget = { window: f.deadWindow, inner: null, capability: "full", reason: null };
        const r = await adapter.focus(target, OPTS);
        const ok = r.status === "failed" && r.code === "not_found";
        return { rule, ok, detail: `status=${r.status} code=${r.code}` };
      }
      case "PA-07": {
        const t0 = Date.now();
        await adapter.notify(SAMPLE, () => {});
        const first = Date.now() - t0;
        const t1 = Date.now();
        await adapter.notify(SAMPLE, () => {});
        const second = Date.now() - t1;
        const ok = first <= 6000 && second <= 2000;
        return { rule, ok, detail: `first=${first}ms second=${second}ms` };
      }
      case "PA-09": {
        const dead = await adapter.processAlive(f.deadPid, null);
        const live = await adapter.processAlive(process.pid, null);
        return { rule, ok: dead === false && live === true, detail: `dead=${dead} live=${live}` };
      }
      default:
        throw new Error(`unknown rule ${rule}`);
    }
  } finally {
    await adapter.dispose();
  }
}

/** Runs the generic PA-01, PA-02, PA-04, PA-07, PA-09 checks, each on a fresh adapter. */
export async function checkConformance(
  make: () => Promise<PlatformAdapter>,
  fixtures: ConformanceFixtures,
): Promise<ConformanceResult[]> {
  const out: ConformanceResult[] = [];
  for (const { rule } of RULES) {
    try {
      out.push(await runRule(rule, make, fixtures));
    } catch (err) {
      out.push({ rule, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Registers one Vitest test per rule, titled `conformance: <rule> <description>`. */
export function runConformance(name: string, make: () => Promise<PlatformAdapter>, fixtures: ConformanceFixtures): void {
  describe(name, () => {
    for (const { rule, description } of RULES) {
      it(`conformance: ${rule} ${description}`, async () => {
        const r = await runRule(rule, make, fixtures);
        expect(r.ok, r.detail).toBe(true);
      });
    }
  });
}
