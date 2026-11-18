# Codex adapter: real-run proof with D-37 chaining (T073)

Date: 2026-11-12 (local 00:0x 11-13 UTC). Host: dev-pc. Codex: codex-cli 0.160.0 (an "update available" banner was shown; not taken). Node: v24. Branch task/T073-codex-proof. Real Windows platform (MC_PLATFORM unset).

Result: PASS. The real `mc install codex` wrapped Woody's existing notify, the real Codex CLI fired it, one codex card appeared (no title-thread duplicate), and `mc uninstall codex` put the original line back exactly. Chain firing of the computer-use program was NOT directly observed (see Chain evidence).

## Commands (MC_HOME=%TEMP%\mc-codex-proof73\home, MC_PORT=53022, both set for daemon, mc and the Codex process)
1. `node packages/cli/dist/mc.js daemon` (hidden) -> `mc status`: `daemon pid=27476 port=53022 sessions=0`.
2. `mc install codex` -> "codex: notify added to C:\Users\you\.codex\config.toml", exit 0. config.toml was not hand-edited.
   Installed line:
   `notify = ["C:/Program Files/nodejs/node.exe", "<worktree>/packages/hook/dist/mc-hook.js", "codex", "--chain", "WyJDOlxcUHJvZ3JhbSBGaWxlc1xc...ZS5leGUiLCJ0dXJuLWVuZGVkIl0"]` (the base64url decodes to the original argv: the codex-computer-use.exe path plus "turn-ended"; abbreviated here, full value is in the install manifest of the temp MC_HOME).
3. Temp repo %TEMP%\mc-codex-proof73\codex-demo (one commit, branch codex-demo).
4. Interactive `cmd /k codex -s read-only -a never "Reply with the single word: ready"` in its own console window, cwd codex-demo. Two prompts appeared and were answered by injecting console input: "Background server has incompatible feature settings" -> option 1 "Run without daemon this time" (does not persist settings); folder trust -> "Trust and continue" (writes a trust entry). Codex replied `ready`; it stayed alive.
5. `mc status`: `daemon pid=27476 port=53022 sessions=1` / `MC-01  IDLE  codex-demo  WINDOWS TERMINAL  21s`.
6. `GET /api/state` (bearer from the temp MC_HOME token file, never printed): exactly 1 session. adapter=codex, nativeId=01a1d313-49b9-7221-ac84-69d2ba2364ac, project=codex-demo, branch=codex-demo, state=idle, attention.active=true reason=done message="ready", lastEvent agent-turn-complete "Turn complete", process.alive=true (agentPid 31000), host windows-terminal.
7. `POST /api/pair-code` with NO content type (Invoke-WebRequest, no body): status 200, JSON `{code, expiresAt}` (D-37 fix confirmed; T071 got 415). Code value not recorded here.
8. playwright-cli: opened the daemon root, a second pair-code (200) was fetched, code typed into `pair-input` (e22) and `pair-submit` (e23) clicked (never in a URL or file), resize 1440x900, `screenshot --full-page`, `snapshot e39` (the card).
9. `mc uninstall codex` -> "codex: removed notify from ...config.toml", exit 0. The config's notify line is exactly the original again:
   `notify = [ "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_modules\\@oai\\sky\\bin\\windows\\codex-computer-use.exe", "turn-ended" ]`

## Chain evidence
- Observed: after the turn, no `hook-errors.log` exists anywhere under the temp MC_HOME, so the hook logged no chain error (malformed or failed-to-start chain would have been logged per ingest.md 6.1). The hook itself ran (the card exists), and the installed argv decodes to the original program and "turn-ended". The target exe exists on disk.
- Not observed: that codex-computer-use.exe actually started. A hidden watcher polled Win32_Process for `codex-computer-use.exe` every ~100 ms from before the first Enter until after the turn and caught nothing (the process is short-lived or exits faster than the poll, or Codex's own app may be what handles it). So chain firing is inferred (no error, correct argv), not proven by a process sighting. The sky exe was not run by hand to avoid side effects on Woody's computer-use app.

## Evidence files
- docs/validation/agents/codex-board.png: paired board, one card MC-01 (NOMINAL, MECO, WIN TERMINAL, codex-demo, branch codex-demo, "LAST Turn complete", ALERTS 1), header GO 1, HOLD 0, NO-GO 0, LOS 0.
- docs/validation/agents/codex-card-snapshot.yml: accessibility snapshot of the MC-01 card.

## config.toml SHA-256 (C:\Users\you\.codex\config.toml)
- before (backup): AAB7EA81FD8374C94CD192CD3F8DC29481DD3830499C393F4FAB31ED773932C0
- after `mc uninstall codex`, before restore: 56CA479F59A1320897C342FDE38695517EB4A2C397D98C8233310CD960D4EE35. Line diff against the backup: only a new `[projects.'c:\users\you\appdata\local\temp\mc-codex-proof73\codex-demo']` table with `trust_level = "trusted"` (Codex's trust entry, from the prompt). The notify line was identical.
- after restoring the backup byte-for-byte: AAB7EA81FD8374C94CD192CD3F8DC29481DD3830499C393F4FAB31ED773932C0 (identical).

## Problems and notes
- Codex's console is not a visible window when started from this agent; the two prompts were answered by writing to the console input of my own cmd process (by PID), and the screen was read back from its console buffer.
- The first attempt (cmd /c) produced no card: it stopped at the "Background server incompatible" prompt and an unattended Enter/exit left it. It spawned Codex app-server daemon children, killed by PID. Also my first Enter attempt used WScript SendKeys, which reported AppActivate=False and so may have gone to whichever window was foreground; nothing visible changed.
- The page logs 8 console errors while unpaired (401 fetches), as in T071, not investigated.
- The Codex process is gone after the run; processes started by me (daemon 27476 and its launcher 36748, cmd 24016, codex 31000, app-server children 28100 and 36432, the watcher) were stopped by PID.
