import type { Adapter, FocusResult, Session } from "@mc/contracts";

/** The two signal colours plus "no hue" (DESIGN.md 1). */
export type Signal = "go" | "look" | "none";

const STATE_WORD: Record<Session["state"], string> = {
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  needs_permission: "Needs permission",
  needs_input: "Needs input",
  error: "Error",
  ended: "Ended",
  lost: "Lost",
};

const isDead = (s: Session): boolean => s.state === "ended" || s.state === "lost";

/** DESIGN.md 4: the plain state word. An idle session with done attention reads "Done". */
export function stateLabel(s: Session): string {
  if (s.state === "idle" && s.attention.active && s.attention.reason === "done") return "Done";
  return STATE_WORD[s.state];
}

/** look = needs you (attention active) or error; go = working or idle; none = the rest. */
export function signalOf(s: Session): Signal {
  if (s.state === "error") return "look";
  if (s.attention.active && !isDead(s)) return "look";
  if (s.state === "working" || s.state === "idle") return "go";
  return "none";
}

/** DESIGN.md 3, host badge, in plain case. */
export function hostBadge(h: Session["host"]): string {
  let text: string;
  switch (h.kind) {
    case "vscode-extension":
      text = "VS Code · Claude";
      break;
    case "vscode-terminal":
      text = "VS Code";
      break;
    case "windows-terminal":
      text = "Windows Terminal";
      break;
    case "conhost":
      text = "Console";
      break;
    case "macos-terminal":
      text = "Terminal";
      break;
    case "iterm2":
      text = "iTerm2";
      break;
    case "wezterm":
      text = "WezTerm";
      break;
    case "kitty":
      text = "kitty";
      break;
    case "linux-terminal":
      text = h.app ?? "Terminal";
      break;
    case "remote":
      text = "Remote";
      break;
    case "unknown":
      text = "Unknown";
      break;
  }
  return h.multiplexer ? `${text} + tmux` : text;
}

const ADAPTER_BADGE: Record<Adapter, string> = {
  "claude-code": "CC",
  codex: "CX",
  "copilot-cli": "CP",
  shell: "SH",
  generic: "GN",
};

/** Mono letter badge per adapter; adapters never get a colour (D-48 3). */
export function adapterBadge(a: Adapter): string {
  return ADAPTER_BADGE[a];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const seconds = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0);

// HH:MM:SS, hours not capped; negative or non-finite input reads as zero.
export function hms(ms: number): string {
  const total = seconds(ms);
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

/** Waited time: MM:SS under an hour, then H:MM:SS. */
export function wait(ms: number): string {
  const t = seconds(ms);
  const h = Math.floor(t / 3600);
  return `${h > 0 ? `${h}:${pad2(Math.floor((t % 3600) / 60))}` : pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

// <n>s under 60 s, <n>m under 60 m, else <n>h.
export function age(ms: number): string {
  const s = seconds(ms);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Local wall clock HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// DESIGN.md 6, fix-it text per RestoreReason.
const FIX_TEXT: Record<string, string> = {
  remote_session: "Remote session (SSH). Restore it from the machine it runs on.",
  no_window_found: "No window found for this session.",
  wayland_unsupported_compositor:
    "This Wayland compositor does not let apps focus windows. Focus it manually; cwd copied.",
  gnome_extension_missing: 'Install the "Window Calls" GNOME extension to enable restore.',
  macos_accessibility_denied:
    "Grant Accessibility: System Settings > Privacy & Security > Accessibility.",
  macos_automation_denied:
    "Grant Automation for this terminal: System Settings > Privacy & Security > Automation.",
  vscode_bridge_missing: "Install the bridge: npm run mc -- install vscode",
  vscode_window_unbound: "Click into this VS Code window once so Mission Control can learn it.",
  tab_not_addressable: "Window comes forward; pick the tab yourself.",
  multiplexer_detached: "tmux session has no attached client.",
  process_ended: "Session ended.",
  target_elevated: "Running as administrator. Restore cannot bring it forward; switch to it yourself.",
};

export function fixText(reason: string | null, detail?: string): string {
  if (reason === null) return "";
  if (reason === "platform_error") return detail ?? "";
  return FIX_TEXT[reason] ?? "";
}

const MACOS_DENIED = new Set<string>(["macos_accessibility_denied", "macos_automation_denied"]);

/** DESIGN.md 3, restore capability in words. */
export function capabilityWord(s: Session): string {
  if (s.restore.reason !== null && MACOS_DENIED.has(s.restore.reason)) return "Needs access";
  switch (s.restore.capability) {
    case "full":
      return "Full";
    case "window":
      return "Window only";
    case "none":
      return "None";
  }
}

/** The sentinel detail copyCwd writes, so the result reads "Focus manually". */
export const FOCUS_MANUALLY = "FOCUS MANUALLY";

/** DESIGN.md 3, the restore result shown for 5 s. */
export function resultText(r: FocusResult): { text: string; signal: Signal } {
  if (r.detail === FOCUS_MANUALLY) return { text: "Focus manually · cwd copied", signal: "none" };
  switch (r.code) {
    case "focused":
      return { text: "Focused", signal: "go" };
    case "focused_window_only":
      return { text: "Window only", signal: "none" };
    case "flashed":
      return { text: "Flashed in the taskbar", signal: "none" };
    default:
      return { text: `Failed · ${r.code.replace(/_/g, " ")}`, signal: "look" };
  }
}
