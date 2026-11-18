import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore, Paths } from "../src/internal.js";
import { loadConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "paths.json");

type Case = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; expected: Paths };

const tmpDirs: string[] = [];
const stores: ConfigStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(extraEnv: NodeJS.ProcessEnv = {}): Promise<{ env: NodeJS.ProcessEnv; paths: Paths }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "mc-config-"));
  tmpDirs.push(home);
  const env: NodeJS.ProcessEnv = { MC_HOME: home, ...extraEnv };
  return { env, paths: resolvePaths(env, process.platform, home) };
}

async function openStore(paths: Paths, env: NodeJS.ProcessEnv): Promise<ConfigStore> {
  const r = await loadConfig(paths, env);
  if (!r.ok) throw new Error(`loadConfig failed: ${r.errors.join("; ")}`);
  stores.push(r.store);
  return r.store;
}

// Real timers: fs.watch delivers real events. Polls at 25 ms, gives up after 2 s.
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("T014 paths and config store", () => {
  it("CF-01 resolvePaths matches every case in fixtures/paths.json", () => {
    const cases = JSON.parse(readFileSync(FIXTURE, "utf8")) as Case[];
    expect(cases.length).toBeGreaterThanOrEqual(7);
    for (const c of cases) {
      expect(resolvePaths(c.env, c.platform, c.home)).toEqual(c.expected);
    }
  });

  it("CF-02 missing config file yields defaults", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    expect(store.get().version).toBe(1);
    expect(store.get().port).toBe(47800);
    expect(store.get().ui.theme).toBe("console");
    expect(store.get().notifications.enabled).toBe(true);
    expect(store.error()).toBeNull();
  });

  it("CF-03 invalid JSON yields ok:false with a config invalid line", async () => {
    const { env, paths } = await setup();
    await loadConfig(paths, env); // creates configDir
    await writeFile(paths.configFile, "{ not json", "utf8");
    const r = await loadConfig(paths, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/^config invalid: /);
  });

  it("CF-04 schema violation reports the instancePath", async () => {
    const { env, paths } = await setup();
    await loadConfig(paths, env);
    await writeFile(paths.configFile, JSON.stringify({ port: 80 }), "utf8");
    const r = await loadConfig(paths, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith("config invalid: /port "))).toBe(true);
  });

  it("CF-05 MC_PORT=0 overrides port", async () => {
    const { env, paths } = await setup({ MC_PORT: "0" });
    const store = await openStore(paths, env);
    expect(store.get().port).toBe(0);
  });

  it("CF-06 hot reload applies a valid edit and notifies listeners", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    let notified = 0;
    store.onChange(() => {
      notified += 1;
    });
    await writeFile(paths.configFile, JSON.stringify({ ui: { showEnded: false } }), "utf8");
    await waitFor(() => notified > 0, "listener");
    expect(store.get().ui.showEnded).toBe(false);
    expect(store.error()).toBeNull();
  });

  it("CF-07 hot reload of an invalid edit keeps the old config and sets error()", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    await writeFile(paths.configFile, JSON.stringify({ port: 80, ui: { showEnded: false } }), "utf8");
    await waitFor(() => store.error() !== null, "error()");
    expect(store.error()).toMatch(/^config invalid: \/port /);
    expect(store.get().ui.showEnded).toBe(true);
    expect(store.get().port).toBe(47800);
  });

  it("CF-08 a later valid edit clears error()", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    await writeFile(paths.configFile, JSON.stringify({ port: 80 }), "utf8");
    await waitFor(() => store.error() !== null, "error()");
    await writeFile(paths.configFile, JSON.stringify({ ui: { showEnded: false } }), "utf8");
    await waitFor(() => store.error() === null && store.get().ui.showEnded === false, "recovery");
    expect(store.error()).toBeNull();
  });

  it("CF-09 a port change on reload keeps the old port", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    await writeFile(paths.configFile, JSON.stringify({ port: 50000, ui: { showEnded: false } }), "utf8");
    await waitFor(() => store.get().ui.showEnded === false, "reload");
    expect(store.get().port).toBe(47800);
    expect(store.error()).toBeNull();
  });

  it("CF-10 close() stops reloading", async () => {
    const { env, paths } = await setup();
    const store = await openStore(paths, env);
    store.close();
    await writeFile(paths.configFile, JSON.stringify({ ui: { showEnded: false } }), "utf8");
    // Longer than the 300 ms debounce plus watch latency, well under 2 s.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(store.get().ui.showEnded).toBe(true);
  });
});
