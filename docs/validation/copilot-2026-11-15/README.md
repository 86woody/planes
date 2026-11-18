# Copilot CLI end to end, packaged 1.0.0, dev-pc, 2026-11-15

GitHub Copilot CLI 1.0.83 against the release tarball (`v1.0.0`, cf757f1), in a temp npm prefix with
its own `MC_HOME` and `MC_PORT=0`. `mc install copilot` wrote the real `~/.copilot/hooks/mission-control.json`;
`mc uninstall copilot` removed it and the `hooks` directory it created. Setup: `cp-setup.ps1`; the
board pass reuses `../fresh-machine-2026-11-15/fm.mjs` (its rows are labelled FM-07/FM-08 in `summary.txt`).

| Check | Result | Note |
|---|---|---|
| Install | PASS | 8 hooks, every `args[0]` is `<MC_HOME>/state/bin/mc-hook.js`, `args[1]` is `copilot-cli` |
| Ingest | PASS | `SessionStart`, `UserPromptSubmit`, `Stop` received; session `copilot-cli` MC-01, title from the prompt, 1 prompt, attention "Turn complete" |
| Target | PASS | Windows Terminal window, capability `full` |
| Board | PASS | paired, 1 card (`fm-07-board.png`) |
| RESTORE | PASS | window minimized, chip FOCUSED, foreground handle equals the target, not iconic (`fm-08-after-restore.png`) |
| End | PASS | after the copilot process exits the session is `ended`, `endReason` `process_exit` |
| Uninstall | PASS | 8 hooks removed, `~/.copilot/hooks` removed, no leftover processes |

Not exercised live: `SessionEnd` (the process was killed, not exited), `PermissionRequest`, `Notification`,
`PostToolUse`, `PostToolUseFailure`. These are covered by the ingest unit and integration tests only.
