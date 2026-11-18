// ingest.md sections 2, 3 and 4: the process fingerprint, env allowlist and envelope.
import { readFileSync } from "node:fs";
import { ancestry, ttyOf } from "@mc/platform";
import type { IngestEnvelope, ProcessInfo } from "@mc/contracts";

export type Adapter = IngestEnvelope["adapter"];
export type Origin = IngestEnvelope["origin"];
export type Payload = IngestEnvelope["payload"];

/** Truncate by Unicode code points (the unit Ajv's maxLength counts), appending nothing. */
export function cut(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

/** Replace every character outside the ingest nativeSessionId alphabet, cap at 128. */
export function sanitizeSessionId(raw: string): string {
  return cut(raw.replace(/[^A-Za-z0-9._-]/g, "_"), 128);
}

/** config.md 2: sessions.capturePromptText; missing or invalid means true. */
export function readCapturePromptText(configFile: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFile, "utf8"));
    const sessions = (parsed as { sessions?: { capturePromptText?: unknown } } | null)?.sessions;
    return sessions?.capturePromptText !== false;
  } catch {
    return true;
  }
}

const ENV_ALLOWLIST = [
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM", "WT_SESSION", "WT_PROFILE_ID",
  "ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "KITTY_WINDOW_ID",
  "KITTY_LISTEN_ON", "WEZTERM_PANE", "WEZTERM_UNIX_SOCKET", "WINDOWID", "DISPLAY",
  "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE", "WSL_DISTRO_NAME", "SSH_CONNECTION",
  "CLAUDE_CODE_ENTRYPOINT", "VSCODE_PID",
] as const;

/** ingest.md 2: allowlisted names only, values capped at 256, SSH_CONNECTION becomes "present". */
export function pickEnv(source: NodeJS.ProcessEnv): Origin["env"] {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = source[key];
    if (v === undefined || v === "") continue;
    out[key] = key === "SSH_CONNECTION" ? "present" : cut(v, 256);
  }
  return out as Origin["env"];
}

const norm = (name: string): string => name.toLowerCase().replace(/\.exe$/, "");

/** ingest.md 3 agent rule table. No rule reads another process's command line. */
export function pickAgent(adapter: Adapter, chain: readonly ProcessInfo[]): ProcessInfo | null {
  const first = chain[0];
  const nearest = (name: string): ProcessInfo | undefined => chain.find((p) => norm(p.name) === name);
  if (adapter === "claude-code") {
    return nearest("claude") ?? (first && ["node", "bun"].includes(norm(first.name)) ? first : null);
  }
  if (adapter === "codex") {
    return nearest("codex") ?? (first && norm(first.name) === "node" ? first : null);
  }
  if (adapter === "copilot-cli") return nearest("copilot") ?? null;
  if (adapter === "shell") return first ?? null;
  return null;
}

/** Parent chain from the hook's parent, nearest first, at most 16. Failure means an empty chain. */
export async function currentChain(): Promise<ProcessInfo[]> {
  try {
    return (await ancestry(process.ppid)).slice(0, 16);
  } catch {
    return [];
  }
}

function osOf(platform: NodeJS.Platform): Origin["os"] {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

// ---- Windows console (ingest.md 3). koffi is loaded lazily; any failure leaves the fields null.

interface KoffiLib {
  func(name: string, ret: string, args: string[]): (...a: unknown[]) => unknown;
}
interface KoffiModule {
  load(name: string): KoffiLib;
}
interface Win32 {
  GetConsoleWindow: () => unknown;
  FreeConsole: () => unknown;
  AttachConsole: (pid: number) => unknown;
  GetAncestor: (hwnd: unknown, flags: number) => unknown;
}

const GA_ROOTOWNER = 3;

async function loadWin32(): Promise<Win32 | null> {
  try {
    const mod = (await import("koffi")) as unknown as { default?: KoffiModule } & KoffiModule;
    const koffi: KoffiModule = mod.default ?? mod;
    const k32 = koffi.load("kernel32.dll");
    const u32 = koffi.load("user32.dll");
    return {
      GetConsoleWindow: k32.func("GetConsoleWindow", "uintptr_t", []) as Win32["GetConsoleWindow"],
      FreeConsole: k32.func("FreeConsole", "int", []) as Win32["FreeConsole"],
      AttachConsole: k32.func("AttachConsole", "int", ["uint32"]) as Win32["AttachConsole"],
      GetAncestor: u32.func("GetAncestor", "uintptr_t", ["uintptr_t", "uint"]) as Win32["GetAncestor"],
    };
  } catch {
    return null;
  }
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function hex(n: number): string {
  return "0x" + BigInt(n).toString(16).toUpperCase().padStart(16, "0");
}

async function windowsConsole(agent: ProcessInfo | null): Promise<Origin["console"]> {
  const empty: Origin["console"] = { consoleHwnd: null, ownerHwnd: null };
  const api = await loadWin32();
  if (!api) return empty;
  try {
    let hwnd = toNum(api.GetConsoleWindow());
    if (hwnd === 0 && agent) {
      // Claude Code may spawn hooks with CREATE_NO_WINDOW: borrow the agent's console.
      api.FreeConsole();
      if (api.AttachConsole(agent.pid)) hwnd = toNum(api.GetConsoleWindow());
      api.FreeConsole();
    }
    if (hwnd === 0) return empty;
    const owner = toNum(api.GetAncestor(hwnd, GA_ROOTOWNER));
    return { consoleHwnd: hex(hwnd), ownerHwnd: owner === 0 ? null : hex(owner) };
  } catch {
    return empty;
  }
}

export interface EnvelopeInput {
  adapter: Adapter;
  event: string;
  nativeSessionId: string;
  payload: Payload;
  chain: readonly ProcessInfo[];
}

/** ingest.md 3: sentAt is the process start (performance.timeOrigin), never Date.now(). */
export async function buildEnvelope(input: EnvelopeInput): Promise<IngestEnvelope> {
  const os = osOf(process.platform);
  const agent = pickAgent(input.adapter, input.chain);
  let tty: string | null = null;
  if (os !== "windows" && agent) {
    try {
      tty = await ttyOf(agent.pid);
    } catch {
      tty = null;
    }
  }
  const consoleFields: Origin["console"] =
    os === "windows" ? await windowsConsole(agent) : { consoleHwnd: null, ownerHwnd: null };
  return {
    v: 1,
    adapter: input.adapter,
    event: input.event,
    nativeSessionId: input.nativeSessionId,
    sentAt: Math.floor(performance.timeOrigin),
    seq: 0,
    payload: input.payload,
    origin: {
      os,
      hookPid: process.pid,
      agent,
      ancestry: [...input.chain] as Origin["ancestry"], // at most 16, see currentChain
      tty,
      env: pickEnv(process.env),
      console: consoleFields,
    },
  };
}
