# @mc/vscode-bridge

A VS Code extension that runs inside each VS Code window and connects it to the local
mission-control daemon. It reports the window's workspace and terminals (with shell PIDs),
follows window focus changes, and, when the daemon asks, shows a terminal or the Claude
Code panel.

It runs on the UI side only, so a remote window still connects to the local daemon. Its
terminals report `shellPid: null` because their shells are not local.

## Install

```
npm run mc -- install vscode
```

The extension needs no settings. It reads the daemon's port and token from the same
location the hook uses (see `docs/contracts/config.md`) and reconnects on its own if the
daemon restarts.
