import type { Host, IngestOrigin, ProcessInfo } from "@mc/contracts";

export const VSCODE_NAMES: readonly string[] = [
  "code",
  "code - insiders",
  "code-insiders",
  "codium",
  "cursor",
  "code helper",
  "code helper (plugin)",
  "electron", // only when its parent is one of the others
];
export const SHELL_NAMES: readonly string[] = [
  "bash", "zsh", "fish", "sh", "dash", "pwsh", "powershell", "cmd", "nu", "tcsh", "ksh",
];
export const LINUX_TERMINALS: readonly string[] = [
  "gnome-terminal-server", "konsole", "xfce4-terminal", "alacritty", "foot", "xterm", "urxvt",
  "terminator", "tilix", "ghostty", "ptyxis", "kgx", "lxterminal", "mate-terminal", "qterminal",
  "st",
];

function normalise(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

// Electron counts as VS Code only when its parent (the next entry, nearest-first) is another VS Code name.
function isVSCodeAt(ancestry: readonly ProcessInfo[], i: number): boolean {
  const name = normalise(ancestry[i]?.name ?? "");
  if (!VSCODE_NAMES.includes(name)) return false;
  if (name !== "electron") return true;
  const parent = normalise(ancestry[i + 1]?.name ?? "");
  return VSCODE_NAMES.includes(parent) && parent !== "electron";
}

function findIndex(
  ancestry: readonly ProcessInfo[],
  pred: (i: number) => boolean,
  from = 0,
): number {
  for (let i = from; i < ancestry.length; i++) if (pred(i)) return i;
  return -1;
}

export function classifyHost(origin: IngestOrigin): Host {
  const env = origin.env;
  const ancestry = origin.ancestry;
  const has = (v: string | undefined): boolean => v !== undefined;

  const agentIndex =
    origin.agent === null ? -1 : ancestry.findIndex((p) => p.pid === origin.agent?.pid);
  const vscodeAny = findIndex(ancestry, (i) => isVSCodeAt(ancestry, i));
  const vscodeAfterAgent =
    agentIndex < 0 ? -1 : findIndex(ancestry, (i) => isVSCodeAt(ancestry, i), agentIndex + 1);
  const shellBetween =
    vscodeAfterAgent < 0
      ? true
      : ancestry
          .slice(agentIndex + 1, vscodeAfterAgent)
          .some((p) => SHELL_NAMES.includes(normalise(p.name)));

  const multiplexer =
    has(env.TMUX) && has(env.TMUX_PANE)
      ? { kind: "tmux" as const, pane: env.TMUX_PANE ?? "" }
      : null;

  const display: Host["display"] =
    origin.os === "windows"
      ? "win32"
      : origin.os === "macos"
        ? "cocoa"
        : has(env.WAYLAND_DISPLAY)
          ? "wayland"
          : has(env.DISPLAY)
            ? "x11"
            : null;

  const base = { os: origin.os, display, multiplexer };

  // 1
  if (has(env.SSH_CONNECTION)) return { ...base, kind: "remote", app: null };

  // 2
  if (env.CLAUDE_CODE_ENTRYPOINT === "claude-vscode" || (vscodeAfterAgent >= 0 && !shellBetween)) {
    const vs = vscodeAfterAgent >= 0 ? ancestry[vscodeAfterAgent] : undefined;
    return { ...base, kind: "vscode-extension", app: vs?.name ?? null };
  }

  // 3
  if (env.TERM_PROGRAM === "vscode" || vscodeAny >= 0) {
    const vs = vscodeAny >= 0 ? ancestry[vscodeAny] : undefined;
    return { ...base, kind: "vscode-terminal", app: vs?.name ?? null };
  }

  // 4. A conhost.exe nearer than Windows Terminal is a classic console started from inside WT
  // (`conhost pwsh`): it inherits WT_SESSION and has WT as an ancestor, but its window is conhost (T103).
  const wtIndex = findIndex(ancestry, (i) => normalise(ancestry[i]?.name ?? "") === "windowsterminal");
  const conhostIndex = findIndex(ancestry, (i) => normalise(ancestry[i]?.name ?? "") === "conhost");
  const conhostNearer = conhostIndex >= 0 && (wtIndex < 0 || conhostIndex < wtIndex);
  if (!conhostNearer && (has(env.WT_SESSION) || wtIndex >= 0)) {
    return { ...base, kind: "windows-terminal", app: "WindowsTerminal.exe" };
  }

  // 5
  if (origin.os === "windows" && (origin.console.consoleHwnd !== null || conhostNearer)) {
    return { ...base, kind: "conhost", app: "conhost.exe" };
  }

  // 6
  if (env.TERM_PROGRAM === "Apple_Terminal") {
    return { ...base, kind: "macos-terminal", app: "Terminal" };
  }

  // 7
  if (env.TERM_PROGRAM === "iTerm.app" || has(env.ITERM_SESSION_ID)) {
    return { ...base, kind: "iterm2", app: "iTerm2" };
  }

  // 8
  if (has(env.WEZTERM_PANE)) return { ...base, kind: "wezterm", app: "wezterm-gui" };

  // 9
  if (has(env.KITTY_WINDOW_ID)) return { ...base, kind: "kitty", app: "kitty" };

  // 10
  if (origin.os === "linux") {
    const term = findIndex(ancestry, (i) =>
      LINUX_TERMINALS.includes(normalise(ancestry[i]?.name ?? "")),
    );
    if (term >= 0) {
      return { ...base, kind: "linux-terminal", app: ancestry[term]?.name ?? null };
    }
  }

  // 11
  return { ...base, kind: "unknown", app: null };
}
