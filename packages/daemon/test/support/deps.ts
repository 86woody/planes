import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wsHub } from "../../src/ws.js";
import { createAuth } from "../../src/auth.js";
import { createBridgeRegistry } from "../../src/bridge.js";
import { createFocusService } from "../../src/focus.js";
import { createLiveness } from "../../src/liveness.js";
import { createNotifier } from "../../src/notifier.js";
import { createPersistence } from "../../src/persistence.js";
import { resolvePaths } from "../../src/paths.js";
import { createSessionService } from "../../src/sessions.js";
import { loadConfig } from "../../src/config.js";
import type { Clock, DaemonDeps, Logger, Paths } from "../../src/internal.js";
import { FakePlatform } from "@mc/platform";

export interface TestDeps {
  deps: DaemonDeps;
  paths: Paths;
  platform: FakePlatform;
  clock: Clock & { t: number };
  dispose(): Promise<void>;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

/**
 * A full DaemonDeps from the real modules, with MC_HOME in a temp dir, the fake platform, and a
 * manual clock. Nothing is started (no notifier or liveness timers); tests start what they need.
 */
export async function makeDeps(startAt = Date.UTC(2026, 10, 12, 9, 0, 0)): Promise<TestDeps> {
  const home = mkdtempSync(path.join(os.tmpdir(), "mc-t026-"));
  const env = { MC_HOME: home };
  const paths = resolvePaths(env, process.platform, home);
  const clock = { t: startAt, now: () => clock.t };

  const loaded = await loadConfig(paths, env);
  if (!loaded.ok) throw new Error(`test config invalid: ${loaded.errors.join("; ")}`);
  const config = loaded.store;

  const auth = await createAuth(paths, clock);
  const persistence = createPersistence(paths, clock, silent);
  const initial = await persistence.load();
  const platform = new FakePlatform({});
  const bridges = createBridgeRegistry({ clock, log: silent, platform });
  const sessions = createSessionService({ clock, config, persistence, initial });
  const capCache = { value: null as Awaited<ReturnType<FakePlatform["capabilities"]>> | null, at: 0 };
  const capabilities = {
    async get() {
      if (!capCache.value || clock.now() - capCache.at >= 60_000) {
        capCache.value = await platform.capabilities();
        capCache.at = clock.now();
      }
      return capCache.value;
    },
    invalidate() {
      capCache.value = null;
    },
  };
  const broadcast: DaemonDeps["broadcast"] = (m) => {
    wsHub.emit("msg", m);
  };
  const focus = createFocusService({ clock, log: silent, config, sessions, platform, bridges });
  const notifier = createNotifier({ clock, log: silent, config, sessions, platform, focus, broadcast });
  const liveness = createLiveness({ clock, config, sessions, platform });

  const deps: DaemonDeps = {
    clock,
    log: silent,
    paths,
    config,
    auth,
    sessions,
    persistence,
    bridges,
    focus,
    notifier,
    liveness,
    platform,
    capabilities,
    version: "0.0.0-test",
    startedAt: new Date(startAt).toISOString(),
    broadcast,
    copilot: { current: () => null },
    traces: { addSpan() {}, runs: () => [], flush: async () => undefined }, // D-57 (T117) stub
  };

  return {
    deps,
    paths,
    platform,
    clock,
    async dispose() {
      await persistence.flush();
      await auth.flush();
      config.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
