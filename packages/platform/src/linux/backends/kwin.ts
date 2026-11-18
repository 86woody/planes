import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import dbus from "dbus-next";
import { getDaemonService } from "../dbus-service.js";
import { focusResult, type LinuxBackend, type LinuxWindow } from "./select.js";
import type { FocusOptions } from "../../types.js";

export type KwinParams =
  | { action: "list" }
  | { action: "active" }
  | { action: "focus"; pid: number; caption: string | null; maximize: boolean };

/**
 * KWin script text (linux.md 3.3). Every value enters through JSON.stringify; no raw title
 * is ever concatenated into the source.
 */
export function kwinScript(params: KwinParams): string {
  const want = JSON.stringify(params);
  return `const want = ${want};
const list = typeof workspace.windowList === "function" ? workspace.windowList() : workspace.clientList();
const current = workspace.activeWindow || workspace.activeClient;
const report = (o) => callDBus("org.missioncontrol.Daemon", "/", "org.missioncontrol.Daemon", "Report", JSON.stringify(o));
const describe = (w) => ({ internalId: String(w.internalId), pid: w.pid, caption: String(w.caption),
  resourceClass: String(w.resourceClass), minimized: !!w.minimized, fullscreen: w.fullScreen ? 1 : 0, active: w === current });
const normal = list.filter((w) => w.normalWindow);
if (want.action === "list") {
  report({ windows: normal.map(describe) });
} else if (want.action === "active") {
  report({ windows: current && current.normalWindow ? [describe(current)] : [] });
} else {
  let hit = null;
  for (const w of normal) {
    if (w.pid === want.pid && (!want.caption || String(w.caption).includes(want.caption))) { hit = w; break; }
  }
  if (hit) {
    hit.minimized = false;
    if ("activeWindow" in workspace) workspace.activeWindow = hit; else workspace.activeClient = hit;
    if (want.maximize) hit.setMaximize(true, true);
  }
  const now = workspace.activeWindow || workspace.activeClient;
  report({ found: !!hit, active: !!hit && now === hit });
}
`;
}

export interface KwinWindow {
  internalId: string;
  pid: number;
  caption: string;
  resourceClass: string;
  minimized: boolean;
  fullscreen: number;
  active: boolean;
}

/** Runs one script and returns the Report payload, or null on the 1 s timeout. */
export type KwinRunner = (source: string, nonce: string) => Promise<string | null>;

const REPORT_TIMEOUT_MS = 1000;

/** Typed view of org.kde.kwin.Scripting (dbus-next types methods only as an index signature). */
interface KwinScriptingIface {
  loadScript(file: string, name: string): Promise<number>;
  unloadScript(name: string): Promise<unknown>;
}

/** Production runner: loadScript, run, wait for Report, unload, delete the file (linux.md 3.3). */
export function dbusRunner(scriptPath: string): KwinRunner {
  return async (_source, nonce) => {
    const daemon = await getDaemonService();
    const bus = dbus.sessionBus();
    const name = `mc-${nonce}`;
    let unsubscribe: () => void = () => {};
    try {
      const report = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), REPORT_TIMEOUT_MS);
        unsubscribe = daemon.onReport((json) => {
          clearTimeout(timer);
          resolve(json);
        });
      });
      const scripting = (await bus.getProxyObject("org.kde.KWin", "/Scripting")).getInterface(
        "org.kde.kwin.Scripting",
      ) as unknown as KwinScriptingIface;
      const id = (await scripting.loadScript(scriptPath, name)) as number;
      const script = (await bus.getProxyObject("org.kde.KWin", `/Scripting/Script${id}`)).getInterface(
        "org.kde.kwin.Script",
      ) as unknown as { run(): Promise<unknown> };
      await script.run();
      const result = await report;
      try {
        await scripting.unloadScript(name);
      } catch {
        // already unloaded
      }
      return result;
    } finally {
      unsubscribe();
      bus.disconnect();
    }
  };
}

export function createKwinBackend(deps: { stateDir: string; runScript?: KwinRunner }): LinuxBackend & { dispose(): void } {
  async function run(params: KwinParams): Promise<unknown | null> {
    const nonce = randomBytes(8).toString("hex");
    const source = kwinScript(params);
    const dir = path.join(deps.stateDir, "kwin");
    const file = path.join(dir, `${nonce}.js`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, source, "utf8");
    const runner = deps.runScript ?? dbusRunner(file);
    let json: string | null;
    try {
      json = await runner(source, nonce);
    } finally {
      await rm(file, { force: true });
    }
    if (json === null) return null;
    return JSON.parse(json) as unknown;
  }

  const toWindow = (w: KwinWindow, i: number): LinuxWindow => ({
    id: w.internalId,
    pid: w.pid,
    title: w.caption,
    app: w.resourceClass.toLowerCase(),
    stackIndex: i,
    minimized: w.minimized,
    fullscreen: w.fullscreen,
  });

  async function list(): Promise<LinuxWindow[]> {
    const r = (await run({ action: "list" })) as { windows?: KwinWindow[] } | null;
    return (r?.windows ?? []).map(toWindow);
  }

  return {
    list,

    async active() {
      const r = (await run({ action: "active" })) as { windows?: KwinWindow[] } | null;
      const w = r?.windows?.[0];
      return w === undefined ? null : toWindow(w, 0);
    },

    async focus(w: LinuxWindow, opts: FocusOptions) {
      const maximize = opts.maximize === "always" || (opts.maximize === "if-minimized" && w.minimized === true);
      const r = (await run({ action: "focus", pid: w.pid, caption: w.title === "" ? null : w.title, maximize })) as
        | { found?: boolean; active?: boolean }
        | null;
      if (r === null) return focusResult("timeout", "KWin script did not report within 1 s");
      if (r.found !== true) return focusResult("not_found", "KWin has no matching window");
      if (r.active === true) return focusResult("focused");
      return focusResult("flashed", "KWin did not activate the window");
    },

    dispose() {
      // Each run opens and closes its own session bus connection.
    },
  };
}
