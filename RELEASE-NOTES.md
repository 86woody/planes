# mission-control-desktop 1.0.1

## What this is

Mission Control watches local coding-agent sessions and lets you jump to the one that needs you.
It ships as an npm tarball plus a VS Code extension file, with nothing published to a registry.

## What's new since 1.0.0

- **The Terrain deck board.** A new page: a readiness card, a "Needs you" stack, a fleet terrain map with one region per project, and a list view (key L) of every session. Ended sessions leave the map and stay in the list; the map fits however many projects you have.
- **Typing works right after Restore.** Restoring a Windows Terminal window used to leave keyboard focus on the tab strip, so nothing you typed reached the agent until you clicked. Focus now lands in the terminal.
- **GitHub Copilot CLI tabs are found.** In a Windows Terminal window with several tabs, Restore now selects a Copilot (or Codex) tab, not only Claude Code tabs.
- **The VS Code extension installs on Windows.** In 1.0.0, `mc init` and `mc install vscode` could not install it on Windows (a command-quoting bug). If you are upgrading from 1.0.0 on Windows, run `mc install vscode` once.
- **Unattended `mc init` connects Copilot.** With no terminal to ask on (a script or CI) and no `--agents`, `mc init` connects GitHub Copilot CLI, the default, and says so.
- **An elevated (administrator) window is named as the reason** when Restore cannot reach it, instead of a blank "None".
- **Smaller fixes:** a classic console started from inside Windows Terminal is labelled Console; `mc doctor` no longer warns that notifications are off while they are on; the empty board says `mc init`; the telemetry cards are hidden until there is a data source (key T previews them).

## Install

```
npm i -g ./mission-control-desktop-1.0.1.tgz
mc init
mc launch
```

Node >= 22 is required. `mc init` asks which agents to connect (GitHub Copilot CLI is pre-selected; Claude Code and Codex are the others), installs the VS Code extension when `code`, `code-insiders` or `cursor` is on PATH, and `mc launch` starts Mission Control and opens the page.

### Reference

`mc start` starts the daemon, and `mc open` opens the page. `mc install <target>` installs one target on its own, for example `mc install vscode`; `mc install shell` and `mc install autostart` are not run by `mc init`, so run them yourself if you want them.

## Upgrade

```
mc stop
npm i -g ./mission-control-desktop-<new>.tgz
mc launch
```

`mc launch` (through `mc start`) rewrites the launchers when their target moved, and hooks are not rewritten.
After a Node version switch, run `mc doctor`, which warns `hook-paths`, then run `mc init` again (or `mc install <target>`).

## Uninstall

```
mc stop
mc uninstall <each installed target>
npm rm -g mission-control-desktop
```

Config and state directories stay where they are.

## Known issues

- GitHub Copilot CLI 1.0.112 reports a session only when you send its first prompt, so a new Copilot window appears on the board after you type something.
- When you deny a Copilot permission prompt, Copilot sends no event, so its card keeps saying "Needs permission" until the session does something else.

## Unverified

This release has not been proven on a Mac, and the fresh-machine install was proven on one OS only.

- AC-07: RESTORE on Terminal.app and iTerm2 (no Mac available, PRD Q4).
- The macOS rows of AC-09: notification click restore on macOS.
- MO-01..MO-06: the macOS OS-level tests, which only run on a Mac.
- The macOS manual checklist rows M-01..M-07.
- fresh-machine proof: Windows Sandbox only. No fresh-machine run on Linux or macOS. The Sandbox run used 1.0.0; 1.0.1 was checked by the gates (which install the tarball into a temporary prefix) on Windows and Linux, and by the Windows manual checks with Claude Code and GitHub Copilot CLI on one machine.

## Contents

- mission-control-desktop-1.0.1.tgz
- vscode-bridge-1.0.1.vsix
- RELEASE-NOTES.md
