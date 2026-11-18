# Mission Control: user guide

Mission Control is a page in your browser that lists every AI agent session running on
this machine. Each session is a card. The card tells you what the session is doing and
whether it needs you. One button, Restore, brings that session's window to the front
and maximizes it, wherever it lives: a VS Code terminal, Windows Terminal, a classic
console, Terminal.app, iTerm2 or a Linux terminal. When a session needs you, the
operating system shows a notification. Clicking it restores the session where the
operating system allows.

Nothing leaves the machine. The daemon listens on `127.0.0.1` only, with no account and
no cloud.

## 1. What you need

| | Windows 11 | macOS 13 or later | Linux |
|---|---|---|---|
| Browser | Chromium-based or Firefox, current version | same | same |
| Node.js | 22 or later | 22 or later | 22 or later |
| npm | 9 or later (comes with Node.js) | same | same |
| Permissions | none for the core features | Automation for Terminal or iTerm2; Accessibility for VS Code and maximize | see section 5 |

Supported Linux desktops: X11 with any EWMH window manager, sway, Hyprland, KDE
Plasma 6 on Wayland, and GNOME on Wayland with the extension described in section 5.

Claude Code is the first-class agent. Its hooks report session events to Mission
Control. Codex CLI reports through its `notify` program. Shell integration is optional
and covers plain shells that run no agent.

## 2. Install and start

Install the package, connect your agents, then start Mission Control and open the page:

```
npm i -g ./mission-control-desktop-1.0.0.tgz
mc init
mc launch
```

- The tarball and the VS Code extension file come from the release on forge
  (`RELEASE-NOTES.md` lists both).
- `mc init` asks which agents to connect: GitHub Copilot CLI (pre-selected; press Enter to
  accept), Claude Code and Codex. Type numbers separated by commas to pick others. It
  installs every agent you pick, then the link handler that notification clicks use (on
  Windows and Linux), and the VS Code bridge when `code`, `code-insiders` or `cursor` is on
  your PATH. Running it again repairs a moved or stale install.
  To skip the question, run `mc init --agents copilot,claude-code`. With no terminal to
  ask on (a script or CI) and no `--agents`, it connects GitHub Copilot CLI, the default,
  and says so.
- `mc launch` starts the daemon if it is not running, then opens the page.

### Upgrade

```
mc stop
npm i -g ./mission-control-desktop-<new>.tgz
mc launch
```

Your hooks point at small launchers in the state directory (`bin/`). `mc launch` points the
launchers at the new install, so your agent settings are not rewritten. After you switch
Node versions, `mc doctor` warns `hook-paths`. Run `mc init` again to repair it.

### Reference: individual commands

`mc init` and `mc launch` are built from these. `mc install <target>` connects one target
(`copilot`, `claude-code`, `codex`, `vscode`, `uri-handler`, `shell`, `autostart`). `mc start`
starts the daemon (a second start detects the running daemon and exits without error).
`mc open` opens the page. `mc install claude-code` adds Mission Control's hook entries to
your Claude Code user settings. It keeps your existing hooks and their order, and writes a
backup of the settings file first. `mc install vscode` installs the VS Code bridge
extension, `woody.vscode-bridge`, which lets Mission Control find and focus VS Code windows
and terminals.

### From a clone (developers)

```
npm install
npm run build
npm run mc -- init
npm run mc -- launch
```

In a clone, `npm run mc` runs the same CLI as `mc`.

Optional installers, run only when you want them:

| Command | What it does |
|---|---|
| `mc install uri-handler` | Registers the link handler that notification clicks use to restore a session. `mc init` and `mc install claude-code` also run it on Windows and Linux. |
| `mc install shell` | Writes the shell integration snippet (section 7). |
| `mc install autostart` | Starts the daemon when you log in. |
| `mc install codex` | Connects Codex CLI's `notify` program. If you already have a `notify` program, mc keeps it working: it runs yours after reporting, and `mc uninstall codex` puts your line back exactly. |
| `mc install copilot` | Adds `mission-control.json` to Copilot CLI's user hooks directory (`~/.copilot/hooks`, or `$COPILOT_HOME/hooks`). `mc uninstall copilot` removes it. |

To check the machine at any time, run `mc doctor`. It lists each permission and
dependency for your OS as present or missing, with the fix, and exits 1 if a required
one is missing.

## 3. Reading the page

The page has four parts: the readiness card and the "Needs you" stack on the left, the fleet
terrain in the middle, and the telemetry row at the bottom.

- **Fleet readiness** shows the percent of live sessions that do not need you, and the oldest wait.
- **Needs you** shows up to three cards, the longest wait first. Each card shows the session, the
  state, the wait time and the last message. When the session reports telemetry, one more line
  shows its AI Credits, context used and failed tools.
- **Fleet terrain** is a map. Each region is a project. Each peak is a session. A tall orange peak
  needs you. Where a session reports telemetry, the height of its peak is its token rate.
- **List** (key L) shows all sessions in a table, with telemetry columns you can sort.

Each session has a state:

| State | What it means |
|---|---|
| Starting | The session has started and has not done any work yet. |
| Working | The agent is working. Nothing needs you. |
| Needs permission | The agent waits for a permission decision. |
| Needs input | The agent waits for your answer. |
| Done (`Done · review`) | The agent finished its turn. The alert stays until you acknowledge it. |
| Idle | The session is idle and nothing needs you. |
| Error | An error stopped the agent's turn. |
| Ended | The session ended. It moves to the list, under "Ended and lost". |
| Lost | Mission Control lost the session's process without a clean end. |

Actions on a card or row: **Restore** (Enter) brings the session window forward (section 4).
**Acknowledge** (A) stops the alert. **Dismiss** (D) removes an alert, or an ended session.
**Details** (I) opens a side panel. **O** opens the session page.

The Restore column in the list shows how far Restore can go: `Full` (window and tab),
`Window only`, `None` (hover for the reason and the fix) or `Needs access` (a macOS permission).

### Telemetry

Mission Control reads the logs that the agents write on this computer. It does not send them
anywhere, and it never reads the text of prompts, answers or tool output.

| Agent | Source | What you get |
|---|---|---|
| Claude Code | the session transcript in `~/.claude/projects` | tokens, token rate, context used, model calls, errors, tools, subagents, run traces |
| Copilot CLI | `~/.copilot/session-state/<id>/events.jsonl`, and OTel files from the shell integration (section 7) | the same, plus AI Credits |
| VS Code Copilot Chat | the OTel file set in VS Code settings (`github.copilot.chat.otel.*`) | run traces; reload the VS Code window after you change the settings |
| Codex, shell | none yet | "No data" or "n/a" |

The telemetry row has four cards. They show all live sessions, or only the selected session:

- **Token rate**: new tokens per minute (input, cache writes, output). A rewrite of the prompt
  cache counts, so short peaks are normal.
- **Context used**: how full the fullest context window is. The `≈` means it is an estimate.
- **AI Credits**: Copilot credits used today, the percent of the month and the forecast. The card
  turns orange when the forecast is over 100%. Claude Code on a subscription has no credits.
- **Error rate**: failed model calls as a percent of all model calls.

The row appears when a session reports telemetry. Key T hides it or shows it. A card with no
source shows a dash and the reason, never a number. The header shows the Copilot credits pill.

The **session page** (key O, or the Open link in the list) shows one session: six key values,
a bar for each model call, its runs, tools, permissions and subagents. Click a run to see its
**run trace**: a timeline of each model call and each tool call in that run.
## 4. Restore

Pressing Restore (or Enter) asks the daemon to bring the session forward. The button reads
`Restoring…` while the request is in flight. Afterwards a result appears on the card or row
for five seconds:

| Chip | Meaning |
|---|---|
| `Focused` | The window is in front and maximized, and the right tab or terminal is selected. |
| `Window only` | The window is in front and maximized, but the tab or panel inside it is yours to pick. |
| `Flashed in the taskbar` | The operating system would not bring the window forward. It flashed the taskbar or Dock icon instead. |
| `Failed · <reason>` | Restore failed. The code is the reason from the troubleshooting table in section 8. |
| `Focus manually · cwd copied` | This session has no way to be restored from here. No request was sent. Mission Control copied the session's folder path to the clipboard. Switch to the window yourself. |

"Maximized" means the operating system's maximized state, not full screen.

## 5. Permissions and dependencies per OS

### Windows 11

- Windows PowerShell 5.1, built in. Without it, notifications and Windows Terminal tab
  selection are off.
- Notifications need the one-time registration, `mc install uri-handler`. Also
  check that Settings > System > Notifications allows notifications for Mission Control.
- Run the daemon as your normal user, not elevated. An elevated daemon cannot be reached
  by the notifications of non-elevated sessions and confuses the foreground rules.
- A window running as administrator cannot be restored from a normal-user daemon. Its
  Restore column shows `None`.

### macOS

| Permission | Needed for | Where to grant it |
|---|---|---|
| Automation for Terminal and iTerm2 | selecting the tab and zooming the window | System Settings > Privacy & Security > Automation. Enable Terminal, and iTerm2 if you use it, under the app that runs the daemon. |
| Accessibility | VS Code windows, other apps, maximizing apps that do not expose scripting | System Settings > Privacy & Security > Accessibility. Add the app that runs the daemon. If you started it from Terminal, that is Terminal. If launchd started it, add the `node` binary that `mc doctor` prints. |
| Notifications for alerter or terminal-notifier | clickable notifications | System Settings > Notifications, then the alerter entry |

macOS attributes these permissions to the "responsible process": the terminal app when
you started the daemon from a terminal, the `node` binary when launchd started it.
`mc doctor` prints which one applies.

Without a clickable notifier, clicking a notification opens the page with that card
highlighted.

### Linux

| Dependency | Needed for | How to get it |
|---|---|---|
| `wmctrl` and `xprop` | focus on X11 | `sudo apt install wmctrl x11-utils` on Debian or Ubuntu; `sudo dnf install wmctrl xprop` on Fedora |
| `xdotool` | X11 fallback | optional |
| `swaymsg` or `hyprctl` | sway or Hyprland | ships with the compositor |
| KWin scripting over D-Bus | KDE Plasma 6 on Wayland | ships with Plasma |
| "Window Calls" GNOME extension | GNOME on Wayland | extensions.gnome.org, extension 4724 |
| A notification server on D-Bus | notifications | every desktop ships one; on a bare window manager install `dunst` or `mako` |
| `tmux` 3.0 or later | tmux sessions | your package manager |

GNOME on Wayland needs the Window Calls extension. Without it, Restore shows `None` with
the fix text, and nothing else breaks. Other Wayland compositors that do not let apps
focus windows show `None` too, and you focus the window yourself.

## 6. Notifications

Mission Control raises one operating system notification each time a session enters an
attention state: a permission decision, a request for input, an error, or a finished
turn. A repeat within ten seconds sends nothing. With `suppressWhenFocused` on, no
notification is sent while the session's own window is in front.

Clicking a notification restores the session on Windows, on X11, sway, Hyprland and KDE.
On macOS it restores the session when alerter or terminal-notifier is installed; with
neither, the click opens the page with the card highlighted.

## 7. Shell integration (optional)

`mc install shell` writes a snippet for your shell to `<stateDir>/shell/mc.<ext>`.
The state directory is listed in section 9. Use the file for your shell: bash, zsh or
PowerShell. Load it from your shell's startup file.

Read these before you install it:

- **bash and zsh:** the snippet replaces an existing `EXIT` trap in your shell. If you
  have your own `EXIT` trap, it stops running once the snippet is loaded.
- **PowerShell:** the snippet replaces the Enter key binding.

Shell integration covers plain shells that run no agent. Sessions started by Claude Code
or Codex CLI do not need it.

The snippet also sets `COPILOT_OTEL_FILE_EXPORTER_PATH` to `<stateDir>/otel/shell-<pid>.jsonl` in
each shell, unless you set it yourself. Copilot CLI then writes its traces there, and the
telemetry row and the run traces use them (section 3). Prompt text is never captured.

## 8. Troubleshooting

When Restore cannot work, the tooltip of the Restore column and the `Failed` result show the fix
text. The table gives each reason and its fix.

| Reason | Fix |
|---|---|
| `remote_session` | Remote session (SSH). Restore it from the machine it runs on. |
| `no_window_found` | No window found for this session. |
| `wayland_unsupported_compositor` | This Wayland compositor does not let apps focus windows. Focus it manually; cwd copied. |
| `gnome_extension_missing` | Install the "Window Calls" GNOME extension to enable restore. |
| `macos_accessibility_denied` | Grant Accessibility: System Settings > Privacy & Security > Accessibility. |
| `macos_automation_denied` | Grant Automation for this terminal: System Settings > Privacy & Security > Automation. |
| `vscode_bridge_missing` | Install the bridge: `mc install vscode` |
| `vscode_window_unbound` | Click into this VS Code window once so Mission Control can learn it. |
| `tab_not_addressable` | Window comes forward; pick the tab yourself (TAB: MANUAL). |
| `multiplexer_detached` | tmux session has no attached client. |
| `process_ended` | Session ended. |
| `platform_error` | The detail shown on the chip. |

Other things to check:

- **The card shows `WINDOW` but you expected `FULL`.** Check that the terminal tab is the
  one the session runs in. On Windows Terminal with several tabs whose titles match, the
  tab cannot be told apart and the card shows `WINDOW`.
- **A VS Code panel does not come forward.** The bridge can bring the VS Code window
  forward. Revealing the Claude Code panel depends on that extension's command ids,
  which are not yet verified. When the panel does not reveal, the chip shows
  `WINDOW ONLY`.
- **Sessions in WSL do not appear.** They appear only when WSL can reach the host's
  `127.0.0.1` (mirrored networking). Otherwise they are invisible to Mission Control.
- **SSH sessions appear with `Remote`.** They cannot be restored from this machine.

## 9. Uninstall and file locations

Remove everything mission-control added, then the package:

```
mc uninstall --all --purge
npm rm -g mission-control-desktop
```

`mc uninstall --all` stops the daemon and removes what every installer added (agent hooks,
the shell snippet, the URI handler, autostart, the VS Code extension), each exactly the
entries it wrote, leaving the rest of your settings alone. `--purge` then deletes the config
and state directories below; leave it out to keep them. If a target fails, the others are
still removed, nothing is purged, and the command exits 1: fix the failure and run it again.
Run `mc uninstall --all` before `npm rm`: npm itself runs no clean-up.

To remove one target only: `mc uninstall <copilot|claude-code|codex|shell|uri-handler|autostart|vscode>`.
Settings you added by hand (for example VS Code's `github.copilot.chat.otel.*`) are yours to remove.

Where the files live. The state directory holds the daemon's session records, logs and
the shell snippet.

| | Config directory | State directory |
|---|---|---|
| Windows | `%APPDATA%\mission-control` | `%LOCALAPPDATA%\mission-control` |
| macOS | `~/Library/Application Support/mission-control` | `~/Library/Application Support/mission-control/state` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/mission-control` | `${XDG_STATE_HOME:-~/.local/state}/mission-control` |

Files you may look at:

| File | What it is |
|---|---|
| `config.json` in the config directory | Your settings. You write it. A missing file means all defaults. |
| `token` in the state directory | The secret the page uses to talk to the daemon. Keep it private. `mc token rotate` replaces it. |
| `daemon.log` in the state directory | The daemon's log. It rotates at 5 MiB. |
| `hook-errors.log` in the state directory | Errors from the hook that reports Claude Code events. It never blocks Claude Code. |
| `install-manifest.json` in the state directory | What each installer added, so uninstall removes exactly that. |
| `bin/` in the state directory | The launchers your agent hooks run (`mc-hook.js`, `mc.js`). `mc launch` keeps them pointed at the installed package. |

The hook never creates the config directory. The daemon creates both directories on
start.
