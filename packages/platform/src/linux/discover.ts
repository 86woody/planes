import { readFile } from "node:fs/promises";
import type { Host, IngestOrigin, RestoreReason } from "@mc/contracts";
import type { Exec } from "../exec.js";
import type { InnerSelector, NativeWindow, PlatformEnv, ResolvedTarget } from "../types.js";
import { createGnome } from "./backends/gnome.js";
import { createHyprland } from "./backends/hyprland.js";
import { createKwinBackend } from "./backends/kwin.js";
import { createSway } from "./backends/sway.js";
import { createX11, sameX11Id } from "./backends/x11.js";
import { selectBackend, type LinuxBackend, type LinuxBackendName, type LinuxWindow } from "./backends/select.js";
import { listTmuxClients, mostRecentClient, psTtyName, rememberPaneSocket, tmuxSocket } from "./tmux.js";

export interface Discover {
  resolveTarget(origin: IngestOrigin, host: Host): Promise<ResolvedTarget>;
  windowExists(w: NativeWindow): Promise<boolean>;
  foregroundWindow(): Promise<NativeWindow | null>;
  listWindows(appNames: string[]): Promise<NativeWindow[]>;
}

export type ProcReader = (pid: number) => Promise<string | null>;

export interface ProcStat {
  comm: string;
  ppid: number;
  starttime: string;
}

/** /proc/<pid>/stat. comm may hold spaces and parentheses, so fields are read after the last close paren. */
export function parseProcStat(stat: string): ProcStat | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // fields[0] is field 3 (state), so field n is fields[n - 3].
  const ppid = Number(fields[1]);
  const starttime = fields[19];
  if (!Number.isInteger(ppid) || starttime === undefined || starttime === "") return null;
  return { comm: stat.slice(open + 1, close), ppid, starttime };
}

const defaultProc: ProcReader = (pid) => readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);

/** Ancestry from start upward, nearest first, at most 16 entries (ingest.md 2). */
export async function readAncestry(
  start: number,
  read: ProcReader,
): Promise<Array<{ pid: number; name: string; startTime: string }>> {
  const out: Array<{ pid: number; name: string; startTime: string }> = [];
  let pid = start;
  for (let i = 0; i < 16 && pid > 1; i++) {
    const raw = await read(pid);
    if (raw === null) break;
    const st = parseProcStat(raw);
    if (st === null) break;
    out.push({ pid, name: st.comm, startTime: st.starttime });
    pid = st.ppid;
  }
  return out;
}

export interface Choice {
  window: LinuxWindow;
  /** True when the process owns several windows (linux.md 2.1). */
  multi: boolean;
}

/**
 * linux.md 2 and 2.1: the nearest candidate pid with a window wins. Within a multi-window
 * process, the unique window whose title holds the project wins, else the topmost.
 */
export function chooseWindow(windows: LinuxWindow[], pidsNearestFirst: number[], project?: string): Choice | null {
  for (const pid of pidsNearestFirst) {
    const same = windows.filter((w) => w.pid === pid);
    const [only] = same;
    if (only === undefined) continue;
    if (same.length === 1) return { window: only, multi: false };
    const byProject = project ? same.filter((w) => w.title.includes(project)) : [];
    const [projectWindow] = byProject;
    if (byProject.length === 1 && projectWindow !== undefined) return { window: projectWindow, multi: true };
    let top = only;
    for (const w of same) if (w.stackIndex > top.stackIndex) top = w;
    return { window: top, multi: true };
  }
  return null;
}

export interface BackendSet {
  pick(host: Pick<Host, "display"> | null): { name: LinuxBackendName; backend: LinuxBackend } | null;
  gnomeAvailable(): Promise<boolean>;
  dispose(): void;
}

/** One instance of each backend. pick() returns null when the compositor has no backend. */
export function createBackendSet(deps: { exec: Exec; env: PlatformEnv }): BackendSet {
  const { exec, env } = deps;
  const kwin = createKwinBackend({ stateDir: env.stateDir });
  const gnome = createGnome();
  const backends: Record<Exclude<LinuxBackendName, "none">, LinuxBackend> = {
    x11: createX11({ exec }),
    sway: createSway({ exec }),
    hyprland: createHyprland({ exec }),
    kwin,
    "gnome-extension": gnome,
  };
  return {
    pick(host) {
      const name = selectBackend(env.config, env.displayEnv(), host);
      if (name === "none") return null;
      return { name, backend: backends[name] };
    },
    gnomeAvailable: () => gnome.available(),
    dispose() {
      gnome.dispose();
      kwin.dispose();
    },
  };
}

/** Backend calls never reject into the adapter (PA-01). */
export async function safely<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

export function nativeOf(w: LinuxWindow): NativeWindow {
  return { os: "linux", handle: w.id, pid: w.pid, app: w.app, title: w.title };
}

const noTarget = (reason: RestoreReason): ResolvedTarget => ({ window: null, inner: null, capability: "none", reason });

function originPids(origin: IngestOrigin): number[] {
  const pids = [origin.agent?.pid, ...origin.ancestry.map((p) => p.pid)];
  return [...new Set(pids.filter((p): p is number => typeof p === "number"))];
}

export function createDiscover(deps: { exec: Exec; env: PlatformEnv; proc?: ProcReader }): Discover {
  const { exec, env } = deps;
  const readProc = deps.proc ?? defaultProc;
  const sets = createBackendSet({ exec, env });

  /** Outer window candidates for a tmux client: ancestry of the processes on its tty (linux.md 4.1 step 4). */
  async function ttyAncestors(clientTty: string): Promise<number[]> {
    const r = await exec("ps", ["-t", psTtyName(clientTty), "-o", "pid="]);
    if (r.code !== 0) return [];
    const out: number[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 1) continue;
      for (const a of await readAncestry(pid, readProc)) if (!out.includes(a.pid)) out.push(a.pid);
    }
    return out;
  }

  return {
    async resolveTarget(origin, host) {
      if (host.kind === "remote") return noTarget("remote_session");
      const pick = sets.pick(host);
      if (pick === null) return noTarget("wayland_unsupported_compositor");
      if (pick.name === "gnome-extension" && !(await sets.gnomeAvailable())) return noTarget("gnome_extension_missing");

      const windows = await safely(() => pick.backend.list(), []);
      let pids = originPids(origin);
      let inner: InnerSelector | null = null;
      let reason: RestoreReason | null = null;

      // X11: WINDOWID first (linux.md 2).
      const windowId = origin.env.WINDOWID;
      const pinned =
        pick.name === "x11" && windowId !== undefined && windowId !== ""
          ? (windows.find((w) => sameX11Id(w.id, windowId)) ?? null)
          : null;

      const socket = tmuxSocket(origin.env.TMUX);
      const pane = host.multiplexer?.pane ?? origin.env.TMUX_PANE;
      if (socket !== null && pane !== undefined && pane !== "") {
        rememberPaneSocket(pane, socket);
        const client = mostRecentClient(await listTmuxClients(exec, socket));
        if (client === null) {
          reason = "multiplexer_detached";
        } else {
          inner = { tmuxPane: pane };
          const outer = await ttyAncestors(client.tty);
          if (outer.length > 0) pids = outer;
        }
      }
      if (inner === null && reason === null) {
        if (origin.env.KITTY_WINDOW_ID) inner = { kittyWindowId: origin.env.KITTY_WINDOW_ID };
        else if (origin.env.WEZTERM_PANE) inner = { weztermPane: origin.env.WEZTERM_PANE };
      }

      const choice = pinned !== null ? { window: pinned, multi: false } : chooseWindow(windows, pids);
      if (choice === null) return noTarget("no_window_found");

      // linux.md 2.1: several windows and no inner selector to pin one -> window only.
      let capability: ResolvedTarget["capability"] = choice.multi && inner === null ? "window" : "full";
      if (reason === "multiplexer_detached") capability = "window";
      else if (capability === "window") reason = "tab_not_addressable";
      return { window: nativeOf(choice.window), inner, capability, reason };
    },

    async windowExists(w) {
      const pick = sets.pick(null);
      if (pick === null) return false;
      const windows = await safely(() => pick.backend.list(), []);
      return windows.some((x) => x.id === w.handle && x.pid === w.pid);
    },

    async foregroundWindow() {
      const pick = sets.pick(null);
      if (pick === null) return null;
      const w = await safely(() => pick.backend.active(), null);
      return w === null ? null : nativeOf(w);
    },

    async listWindows(appNames) {
      const pick = sets.pick(null);
      if (pick === null) return [];
      const names = new Set(appNames.map((n) => n.toLowerCase().replace(/\.exe$/, "")));
      const windows = await safely(() => pick.backend.list(), []);
      return windows.filter((w) => names.has(w.app)).map(nativeOf);
    },
  };
}
