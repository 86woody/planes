import { createHash } from "node:crypto";
import path from "node:path";
import type { Host, IngestOrigin, ProcessInfo, RestoreReason } from "@mc/contracts";
import type { Exec } from "../exec.js";
import { layout } from "../layout.js";
import { processAlive as processAliveRaw } from "../process/index.js";
import type { InnerSelector, NativeWindow, PlatformEnv, ResolvedTarget } from "../types.js";

export interface Discover {
  resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget>;
  windowExists(w: NativeWindow): Promise<boolean>;
  foregroundWindow(): Promise<NativeWindow | null>;
  listWindows(appNames: string[]): Promise<NativeWindow[]>;
}

export const OSASCRIPT = "/usr/bin/osascript";

export type OsaErrorKind = "automation_denied" | "accessibility_denied" | "other";

/** macos.md 7: -1743 is Automation denied; -25211 or "assistive access" is Accessibility denied. */
export function parseOsascriptError(stderr: string): OsaErrorKind {
  if (/-1743\b/.test(stderr)) return "automation_denied";
  if (/-25211\b|assistive access/i.test(stderr)) return "accessibility_denied";
  return "other";
}

export function scriptPath(name: string): string {
  return path.join(layout().macosScriptsDir, name);
}

export type OsaRun =
  | { ok: true; stdout: string }
  | { ok: false; kind: OsaErrorKind | "timeout"; stderr: string };

/**
 * Runs one script file with argv. JXA (.js) files get `-l JavaScript`. Arguments are only
 * ever passed as argv elements, never spliced into script source.
 */
export async function runOsa(exec: Exec, name: string, args: string[]): Promise<OsaRun> {
  const lang = name.endsWith(".js") ? ["-l", "JavaScript"] : [];
  const r = await exec(OSASCRIPT, [...lang, scriptPath(name), ...args]);
  if (r.timedOut) return { ok: false, kind: "timeout", stderr: r.stderr };
  if (r.code !== 0) return { ok: false, kind: parseOsascriptError(r.stderr), stderr: r.stderr };
  return { ok: true, stdout: r.stdout.trim() };
}

export function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function titleHash(title: string): string {
  return createHash("sha1").update(title).digest("hex").slice(0, 8);
}

export interface TabFind {
  windowId: number;
  tab: number;
  session: string | null;
  minimized: boolean;
  title: string;
}

/** Parses terminal-find / iterm-find output. `{}` and anything malformed give null. */
export function parseTabFind(stdout: string): TabFind | null {
  const v = parseJson(stdout);
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.windowId !== "number" || typeof o.tab !== "number") return null;
  return {
    windowId: o.windowId,
    tab: o.tab,
    session: typeof o.session === "string" ? o.session : null,
    minimized: o.minimized === true,
    title: typeof o.title === "string" ? o.title : "",
  };
}

/** ITERM_SESSION_ID is "w0t0p0:<unique id>"; the unique id is everything after the first colon. */
export function itermUniqueId(sessionEnv: string | undefined): string {
  if (sessionEnv === undefined) return "";
  const i = sessionEnv.indexOf(":");
  return i < 0 ? "" : sessionEnv.slice(i + 1);
}

export type TabLookup =
  | { kind: "found"; tab: TabFind }
  | { kind: "none" }
  | { kind: "failed"; reason: OsaErrorKind | "timeout"; stderr: string };

/** Finds the Terminal.app tab or iTerm2 session for a tty (iTerm2 also falls back to uid). */
export async function findTab(
  exec: Exec,
  app: "Terminal" | "iTerm2",
  tty: string,
  uid: string,
): Promise<TabLookup> {
  const r =
    app === "Terminal"
      ? await runOsa(exec, "terminal-find.applescript", [tty])
      : await runOsa(exec, "iterm-find.applescript", [tty, uid]);
  if (!r.ok) return { kind: "failed", reason: r.kind, stderr: r.stderr };
  const tab = parseTabFind(r.stdout);
  return tab === null ? { kind: "none" } : { kind: "found", tab };
}

/** pid of a running app by exact name (`pgrep -x`), or null. Never launches the app. */
export async function appPid(exec: Exec, name: string): Promise<number | null> {
  const r = await exec("/usr/bin/pgrep", ["-x", name]);
  if (r.code !== 0) return null;
  const n = Number(r.stdout.split(/\s+/).find((s) => s !== ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function axTrusted(exec: Exec): Promise<boolean> {
  const r = await runOsa(exec, "ax-trusted.js", []);
  if (!r.ok) return false;
  const v = parseJson(r.stdout);
  return typeof v === "object" && v !== null && (v as Record<string, unknown>).trusted === true;
}

export interface Frontmost {
  pid: number;
  app: string;
  title: string | null;
}

export async function frontmostInfo(exec: Exec): Promise<Frontmost | null> {
  const r = await runOsa(exec, "frontmost.js", []);
  if (!r.ok) return null;
  const v = parseJson(r.stdout);
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.pid !== "number" || typeof o.app !== "string") return null;
  return { pid: o.pid, app: o.app, title: typeof o.title === "string" ? o.title : null };
}

// tmux: the socket is the first comma field of env.TMUX. The inner selector only carries the
// pane, so the socket seen at resolution time is remembered per pane for focus.
const tmuxSockets = new Map<string, string>();

export function tmuxSocketFor(pane: string): string | undefined {
  return tmuxSockets.get(pane);
}

export function tmuxSocketFromEnv(tmuxEnv: string | undefined): string | undefined {
  const first = tmuxEnv?.split(",")[0];
  return first !== undefined && first !== "" ? first : undefined;
}

/** linux.md 4.1 step 2: the attached client with the highest client_activity. */
export async function tmuxActiveClient(
  exec: Exec,
  socket: string | undefined,
): Promise<{ tty: string; activity: number } | null> {
  const args = [
    ...(socket !== undefined ? ["-S", socket] : []),
    "list-clients",
    "-F",
    "#{client_tty} #{client_activity} #{client_session}",
  ];
  const r = await exec("tmux", args);
  if (r.code !== 0) return null;
  let best: { tty: string; activity: number } | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const [tty, act] = line.trim().split(" ");
    const activity = Number(act);
    if (tty === undefined || tty === "" || !Number.isFinite(activity)) continue;
    if (best === null || activity > best.activity) best = { tty, activity };
  }
  return best;
}

function none(reason: RestoreReason): ResolvedTarget {
  return { window: null, inner: null, capability: "none", reason };
}

function guiPid(origin: IngestOrigin, app: string): number | null {
  const list: readonly ProcessInfo[] = origin.ancestry;
  const hit = list.find((p) => p.name === app);
  return hit === undefined ? null : hit.pid;
}

export function createDiscover(deps: { exec: Exec; env: PlatformEnv }): Discover {
  const { exec } = deps;

  async function listWindows(appNames: string[]): Promise<NativeWindow[]> {
    try {
      if (appNames.length === 0 || !(await axTrusted(exec))) return [];
      const r = await runOsa(exec, "ax-list.js", [JSON.stringify(appNames)]);
      if (!r.ok) return [];
      const v = parseJson(r.stdout);
      if (!Array.isArray(v)) return [];
      const out: NativeWindow[] = [];
      for (const e of v as unknown[]) {
        if (typeof e !== "object" || e === null) continue;
        const o = e as Record<string, unknown>;
        if (typeof o.pid !== "number" || typeof o.app !== "string" || typeof o.title !== "string") continue;
        out.push({ os: "macos", handle: `${o.pid}:${titleHash(o.title)}`, pid: o.pid, app: o.app, title: o.title });
      }
      return out;
    } catch {
      return [];
    }
  }

  async function resolveScripted(
    origin: IngestOrigin,
    app: "Terminal" | "iTerm2",
    socket: string | undefined,
    inner: InnerSelector | null,
    hasMux: boolean,
  ): Promise<ResolvedTarget> {
    const pid = await appPid(exec, app);
    if (pid === null) return none("no_window_found");
    const win = (windowId: string, title: string): NativeWindow => ({
      os: "macos",
      handle: `${app}:${windowId}`,
      pid,
      app,
      title,
    });

    let tty = origin.tty;
    if (hasMux) {
      const client = await tmuxActiveClient(exec, socket);
      if (client === null) {
        return { window: win("0", ""), inner, capability: "window", reason: "multiplexer_detached" };
      }
      tty = client.tty;
    }
    if (tty === null || tty === "") {
      return { window: win("0", ""), inner: null, capability: "window", reason: "tab_not_addressable" };
    }

    const found = await findTab(exec, app, tty, itermUniqueId(origin.env.ITERM_SESSION_ID));
    if (found.kind === "failed") {
      const reason: RestoreReason =
        found.reason === "automation_denied" ? "macos_automation_denied" : "tab_not_addressable";
      return { window: win("0", ""), inner: null, capability: "window", reason };
    }
    if (found.kind === "none") {
      return { window: win("0", ""), inner: null, capability: "window", reason: "tab_not_addressable" };
    }
    return {
      window: win(String(found.tab.windowId), found.tab.title),
      inner: inner ?? { tty },
      capability: "full",
      reason: null,
    };
  }

  async function resolveAx(
    origin: IngestOrigin,
    app: string,
    inner: InnerSelector | null,
    envAddressed: boolean,
  ): Promise<ResolvedTarget> {
    const pid = guiPid(origin, app);
    if (pid === null) return none("no_window_found");

    // WezTerm and kitty are addressed by env and the app; they need no Accessibility.
    if (envAddressed) {
      const window: NativeWindow = { os: "macos", handle: `${pid}:${app}`, pid, app, title: "" };
      return inner === null
        ? { window, inner: null, capability: "window", reason: "tab_not_addressable" }
        : { window, inner, capability: "full", reason: null };
    }

    if (!(await axTrusted(exec))) return none("macos_accessibility_denied");
    const mine = (await listWindows([app])).find((w) => w.pid === pid);
    if (mine === undefined) return none("no_window_found");
    return { window: mine, inner, capability: "window", reason: null };
  }

  async function resolve(origin: IngestOrigin, host: Host): Promise<ResolvedTarget> {
    if (host.kind === "remote") return none("remote_session");
    const mux = host.multiplexer;
    const socket = mux ? tmuxSocketFromEnv(origin.env.TMUX) : undefined;
    if (mux && socket !== undefined) tmuxSockets.set(mux.pane, socket);

    let inner: InnerSelector | null = null;
    if (mux) inner = { tmuxPane: mux.pane };
    else if (host.kind === "wezterm" && origin.env.WEZTERM_PANE !== undefined)
      inner = { weztermPane: origin.env.WEZTERM_PANE };
    else if (host.kind === "kitty" && origin.env.KITTY_WINDOW_ID !== undefined)
      inner = { kittyWindowId: origin.env.KITTY_WINDOW_ID };

    if (host.kind === "macos-terminal") return resolveScripted(origin, "Terminal", socket, inner, mux !== null);
    if (host.kind === "iterm2") return resolveScripted(origin, "iTerm2", socket, inner, mux !== null);
    if (host.app === null) return none("no_window_found");
    const envAddressed = host.kind === "wezterm" || host.kind === "kitty";
    return resolveAx(origin, host.app, inner, envAddressed);
  }

  return {
    async resolveTarget(origin, host) {
      try {
        return await resolve(origin, host);
      } catch {
        return none("platform_error");
      }
    },

    async windowExists(w) {
      try {
        // Owner pid still alive. Window-level re-check is left to focus, which reports not_found.
        return await processAliveRaw(w.pid, null);
      } catch {
        return false;
      }
    },

    async foregroundWindow() {
      try {
        const f = await frontmostInfo(exec);
        if (f === null) return null;
        const title = f.title ?? "";
        return { os: "macos", handle: `${f.pid}:${titleHash(title)}`, pid: f.pid, app: f.app, title };
      } catch {
        return null;
      }
    },

    listWindows,
  };
}
