import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { validateConfig, type Config } from "@mc/contracts";
import type { ConfigStore, Paths } from "./internal.js";

const DEBOUNCE_MS = 300;

type ReadResult = { ok: true; config: Config } | { ok: false; errors: string[] };

// One read + validate pass. Missing file = defaults. Errors use the config.md 3 line format.
async function readConfig(paths: Paths, env: NodeJS.ProcessEnv): Promise<ReadResult> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(paths.configFile, "utf8"));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      const what = err instanceof SyntaxError ? "invalid JSON" : "cannot read";
      return { ok: false, errors: [`config invalid: / ${what}: ${err.message}`] };
    }
  }

  const v = validateConfig(raw);
  if (!v.ok) return { ok: false, errors: v.errors.map((m) => `config invalid: ${m}`) };

  const config = v.value;
  // MC_PORT is the only way to get port 0 (ephemeral). It is applied after validation.
  const portEnv = env.MC_PORT;
  if (portEnv !== undefined && portEnv !== "") {
    const n = Number(portEnv);
    if (!/^\d+$/.test(portEnv) || n > 65535) {
      return { ok: false, errors: ["config invalid: MC_PORT must be an integer 0-65535"] };
    }
    config.port = n;
  }
  return { ok: true, config };
}

export async function loadConfig(
  paths: Paths,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; store: ConfigStore } | { ok: false; errors: string[] }> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });

  const first = await readConfig(paths, env);
  if (!first.ok) return first;

  let current: Config = first.config;
  let lastError: string | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(c: Config) => void>();

  const reload = async (): Promise<void> => {
    const r = await readConfig(paths, env);
    if (closed) return;
    if (!r.ok) {
      lastError = r.errors[0] ?? "config invalid";
      return;
    }
    // port needs a restart; keep the bound value. The caller logs the warning.
    r.config.port = current.port;
    current = r.config;
    lastError = null;
    for (const cb of listeners) cb(current);
  };

  // Watch the directory, not the file: editors replace files on save.
  const watcher: FSWatcher = watch(paths.configDir, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, DEBOUNCE_MS);
  });
  // A watch failure leaves the last good config in force; nothing else to do here.
  watcher.on("error", () => {});

  const store: ConfigStore = {
    get: () => current,
    error: () => lastError,
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };

  return { ok: true, store };
}
