# Copilot CLI adapter: real-run proof (T074)

Date: 2026-11-12 (local 23:0x). Host: dev-pc. GitHub Copilot CLI 1.0.83. Node v24.15.0. Branch task/T074-copilot-proof (built from integration). Real Windows platform. Temp MC_HOME=%TEMP%\mc-copilot-proof\home, MC_PORT=53034 (probed free).

Result: PASS. The real Copilot CLI ran the installed hooks, delivered JSON on stdin, and the daemon created `copilot-cli` sessions; the interactive one shows as a live card (idle, attention reason done).

## Commands (token redacted)

1. Daemon: `node packages/cli/dist/mc.js daemon` (hidden), `mc status` -> `daemon pid=34076 port=53034 sessions=0`.
2. `mc install copilot` -> `copilot-cli: added 8 hook(s) to C:\Users\you\.copilot\hooks\mission-control.json`, exit 0. Before: `%USERPROFILE%\.copilot\hooks` did not exist.
3. Temp repo `%TEMP%\mc-copilot-proof\copilot-demo` (branch copilot-demo, one commit).
4. Non-interactive: `copilot -p "Reply with the single word: ready" --no-auto-update --no-remote` -> reply `ready`, exit 0. Session MC-01 created; it ended at once (SessionEnd, `reason: complete`), like `codex exec`.
5. Interactive: `cmd /c copilot -i "Reply with the single word: ready" --no-auto-update --no-remote` in its own console window. A "Confirm folder trust" prompt appeared; answered option 1 "Yes" (this session only, not "remember"). Copilot stayed alive.
6. Debug capture (outside the repo, temp dir only): `NODE_OPTIONS=--require=<temp>/capture.cjs` plus `MC_HOOK_CAPTURE=<temp file>` in the Copilot env; the preload tees the hook process's stdin and argv at exit. It worked for the `-p` run; it logged nothing for the interactive run (cause not investigated; the hooks did fire there, see events.jsonl).
7. Pairing: `POST /api/pair-code` (bearer, `Content-Type: application/json`), then playwright-cli: open `http://127.0.0.1:53034/`, fill the PAIR box, click PAIR, resize 1440x900, full-page screenshot, snapshot of the card. Code entered through the form only; the token is in no URL or file.
8. Cleanup: killed Copilot (copilot.exe 19248, node 35916, cmd 22200) by PID, `mc uninstall copilot` ("removed 8 hook(s)", exit 0), stopped the daemon (34076 and its launcher 36540).

## Installed hooks file (`hooks/mission-control.json`, commands only)

`{"version":1,"hooks":{<Event>:[{"type":"command","exec":"C:/Program Files/nodejs/node.exe","args":["<worktree>/packages/hook/dist/mc-hook.js","copilot-cli","<Event>"],"timeoutSec":5}]}}` for SessionStart, UserPromptSubmit, PermissionRequest, Notification, PostToolUse, PostToolUseFailure, Stop (timeoutSec 5) and SessionEnd (timeoutSec 2). Eight entries.

## mc status (after both runs)

```
daemon pid=34076 port=53034 sessions=2
MC-01  ENDED       copilot-demo  WINDOWS TERMINAL  1m
MC-02  IDLE        copilot-demo  WINDOWS TERMINAL  13s
```

## /api/state, MC-02 (the live interactive session)

adapter=copilot-cli, nativeId=69f4bb90-c9bc-41cb-a199-77e12445d77d, project=copilot-demo, branch=copilot-demo, title "Reply with the single word: ready", state=idle, attention.active=true reason=done message "Turn complete", lastEvent Stop "Turn complete", process.agentPid=19248 (`copilot.exe`) alive=true, host windows-terminal (WindowsTerminal.exe), restore capability full, stats prompts 1 / tools 0 / notifications 0 / events 3. This matches SM-39 (Stop -> idle + done). MC-01 (`-p` run): state=ended, lastEvent SessionEnd "Session end (complete)", endReason other, prompts 1, notifications 1, events 4.
Temp MC_HOME `hook-errors.log`: does not exist (no hook errors).

## Answers to T070's uncertain list

1. Stdin delivery to an `exec` hook: CONFIRMED. Every event arrived as one JSON object on stdin; argv carried `copilot-cli <Event>` exactly as installed.
2. Events fired: for a plain turn with no tools, `UserPromptSubmit`, `SessionStart`, `Stop`, and (in `-p` mode only) `SessionEnd`. In the interactive session SessionStart came after UserPromptSubmit (the initial prompt is submitted first). No PostToolUse/PermissionRequest/Notification occurred (no tools used). The interactive run emitted no SessionEnd while open, as expected.
3. Payload casing: snake_case with PascalCase hook names, as D-36 says. Captured fields: `hook_event_name`, `session_id`, `timestamp`, `cwd`; UserPromptSubmit adds `prompt`; SessionStart adds `source: "new"` and `initial_prompt`; Stop adds `transcript_path`, `stop_reason: "end_turn"`, `stop_hook_active: false`; SessionEnd adds `reason: "complete"`. So `hook_event_name` IS present on PascalCase payloads. The mapping worked: envelope SessionStart carries `source: "startup"`, and no `prompt`, `initial_prompt` or `transcript_path` reached the daemon beyond the allowlist (UserPromptSubmit payload has `prompt` per the existing allowlist rule).
4. Agent pid: CONFIRMED. The agent is `copilot.exe` (a native binary, child of `node npm-loader.js`, child of cmd). The hook's direct parent is `copilot.exe` (capture ppid equals envelope agent.pid 35784 in the `-p` run; 19248 interactive). The `copilot` rule matched and `process.alive` is correct while it runs.
5. Permission pass-through: NOT EXERCISED (no tool use; no tool permissions granted). Still unconfirmed.
6. Notification types: NONE seen (no Notification event fired in either run).
7. Empty stdout/exit 0 not interfering with approval: NOT EXERCISED.

## Evidence files

- docs/validation/agents/copilot-board.png: full-page board, one live card MC-02 (NOMINAL, MECO, WIN TERMINAL, copilot-demo, branch copilot-demo, title, "LAST Turn complete", PROMPTS 1, TOOLS 0, ALERTS 0, RESTORE and ACK, FULL); header GO 1, LOS 1; SPLASHDOWN (1) holds the ended MC-01.
- docs/validation/agents/copilot-card-snapshot.yml: accessibility snapshot of the MC-02 card.

## Hooks directory, before and after

- Before: `%USERPROFILE%\.copilot\hooks` absent.
- After `mc uninstall copilot`: the directory still existed and held only `mission-control.json.mc-backup-20261112230335` (a 2812-byte backup of the mc-written file, contained `mc-hook`; created by the installer). `mission-control.json` itself was gone. I removed exactly that backup file and the then-empty `hooks` directory. Final: `hooks` absent, as at the start. Nothing else under `.copilot` was read or touched.

## Problems / observations

- `mc uninstall` leaves a `.mc-backup-*` file and the empty `hooks` dir behind (the starting state is not fully restored by uninstall alone). Candidate fix: delete the file's backup and an empty parent dir we created.
- The ended session MC-01 reports `process.alive: true` for a pid that has exited, and `endReason: other` for a SessionEnd with `reason: complete`. Minor.
- MC-02 still showed IDLE about 4 s after its Copilot process was killed (liveness not polled yet or slower); not re-checked after.
- `copilot -p` mode produces an ended card at once (same as `codex exec`); a live card needs interactive mode.
- Folder-trust prompt blocks hooks until answered (SessionStart hook did not fire before trust was confirmed).
- Console shows 8 errors while unpaired (pre-pair 401s), as in the Codex run.
- No adapter mis-mapping found.
