# mission-control build: handoff (2026-11-16, m5 done, 1.0.1 released)

Host: `dev-pc`. Read `CHECKPOINT.md` on `integration` first.

## State

| Item | State |
|---|---|
| `integration` | `m5` (`06d831c`) plus this note |
| `master` | fast-forwarded to `m5` (2026-11-16); renamed from `main` 2026-11-17 |
| Tags | `m0`..`m4`, `m5-pending` (old, on `ddf423f`), `m5` (2026-11-16), `v1.0.0` (cf757f1, forge only), `v1.0.1` (`f6f0dcd`) |
| GitHub | https://github.com/86woody/mission-control is public and holds history-free snapshot commits only (0edd99a, then ec1c052 with npm, 2026-11-17), built from `master` minus 17 sandbox and evidence scripts; never push `master` there. The forge keeps pnpm (Woody, 2026-11-17): it gets nothing from 3d32466 on. |
| Windows gate | `GATE m5 PASS 23/23`, 533/533 ids, on `fc44461`, run by `npm run release`; `docs/validation/gate-windows-2026-11-16-fc44461-release.log` |
| Linux gate | `GATE m5 PASS 23/23`, 532/532 ids, in WSL on `fc44461`; `docs/validation/gate-linux-2026-11-16-fc44461.log` |
| Release | `1.0.1` on the forge (`woody/mission-control`, tag `v1.0.1` at `f6f0dcd`): tgz, vsix, notes; SHA-256 in the body |
| History rewrite (2026-11-16) | Before the first GitHub push of m5, every commit after `bb4bd84` was rewritten so that five screenshots (VS Code's recent folders, a board list with real session messages) are the covered versions throughout and `HANDOFF.md` never names the tailnet forge host. Code is unchanged; hashes changed: `fc44461` (built 1.0.1) is now `f6f0dcd`, `e13ced7` is now `06d831c` (m5); gate logs keep the old hashes. Branches based on the old `integration` (for example `task/T100-terrain-ui`) need a rebase onto the new one. Local backups: branch `backup/integration-pre-rewrite`, tags `backup/*-pre-rewrite` |
| Since 1.0.1 (master) | D-56..D-61: telemetry for Copilot and Claude Code, the session page and run traces, the board on real data, `mc uninstall --all`, npm instead of pnpm. Last gate: `GATE m5 PASS 23/23`, 614/614 ids, on `f8d35af` (`docs/validation/gate-windows-2026-11-17-t125.log`). Not released. |
| Presentation | `docs/presentation/` (deck, C4 diagrams, GIF); published as a private artifact https://claude.ai/artifact/4BKh1JtjKQ53ypUXNYG4qJ |

## 2026-11-16: the Terrain deck board is on integration (D-48, T100)

Merged as 4b6f69b. Post-merge `GATE m5 PASS 23/23` on Windows (521/521, `../gate-post-merge-T100.log` in the check-integration run); the builder's Linux run passed 520/520 (`docs/checkpoints/T100.md`). The W- checklist (blocker 4) now runs on the new board: rebuild the UI (`npm run build`) and restart the live daemon first, because pid 21788 still serves the firing-room build.

## m5 blockers

| # | Item | State |
|---|---|---|
| 1 | Linux gate | DONE 2026-11-14 (fixes 0eacde3, 9de35de; all were test or test-environment bugs) |
| 2 | Toast click-through | DONE 2026-11-16 via W-05: toast body, toast RESTORE button and the notification center each restored the window in front with no console flash (shim mode) |
| 3 | Claude panel command ids | DONE 2026-11-14 against Claude Code 2.1.323 (471214e) |
| 4 | W- checklist | DONE 2026-11-16: W-01..W-10 PASS on the Terrain deck, daemon 1.0.0 (`docs/validation/windows-2026-11-15.md`, evidence in `windows-2026-11-15-evidence/`). Fixed on the way and after: T101 (cmd.exe quoting in `realRun`; 1.0.0 cannot install the VS Code extension on Windows), T102 (D-49 `target_elevated`), T103 (D-50 conhost under WT, doctor notifications), T104 (gate portability), T105 (D-51 terrain shows live sessions and fits its regions; empty note says `mc init`), T106 (D-52 rolling ground for larger fleets; telemetry row hidden until a source exists, T previews it), T107 (D-53 unattended `mc init` connects Copilot), T108 (package test keeps script output), T109 (D-54 Restore leaves keyboard focus in the terminal; tab rule matches Copilot and Codex), T110 (D-55 vsix written outside the bridge folder: the intermittent package-stage failures). Copilot pass with Copilot CLI 1.0.112, CP-01..CP-07 and all eight hook events PASS (`docs/validation/copilot-w-2026-11-16.md`). Gates at 65bada4: Windows 533/533 and Linux 532/532, both `GATE m5 PASS 23/23` (`docs/validation/gate-*-2026-11-16-65bada4.log`); release --skip-gate 5/5 on Linux. Open (recorded, not fixed): Copilot 1.0.112 starts its session only on the first prompt; a denied Copilot permission sends no hook, so the card stays "Needs permission" |
| 5 | Packaging | DONE 2026-11-15: `mission-control-desktop` 1.0.0 (D-39..D-47, T080-T098). `GATE m5 PASS 23/23` on Windows (517/517, `docs/validation/gate-windows-2026-11-15-final.log`) and Linux (516/516, `docs/validation/gate-linux-2026-11-15-final.log`). Fresh-machine FM-01..07 PASS in Windows Sandbox, FM-08 PASS on dev-pc (`docs/validation/fresh-machine-windows-2026-11-15.md`). Released 2026-11-15: tag `v1.0.0` at cf757f1 and the forge release `woody/mission-control` v1.0.0 (tgz, vsix, notes; SHA-256 in the body); Copilot CLI 1.0.83 proven end to end on the packaged build 2026-11-15 (install, ingest, card, RESTORE FOCUSED, end, uninstall; `docs/validation/copilot-2026-11-15/`) |

When 4 (with W-05 covering 2) and 5 are recorded: tag `m5` on `integration`, fast-forward `master`,
push `master`, `integration` and tags to `github`.

## Live state left on the machine

- Daemon running: pid 15808, 127.0.0.1:47800, version 1.0.0, restarted 2026-11-16 from the rebuilt clone at 0afd36e (`npm run mc -- stop` to end it). Claude Code hooks and the uri handler were repaired to the `%LOCALAPPDATA%mission-controlbin` launchers; `mc doctor` is clean except the Windows app-notification toggle (WARN).
- `mc install uri-handler` (HKCU, shim mode) and `mc install claude-code` (9 hook groups in
  the real `~/.claude/settings.json`) are installed. Keep them for the W- checks;
  `npm run mc -- uninstall claude-code` / `uri-handler` reverse them.
- A Windows Terminal window titled `MC-W01` runs `claude` in `%TEMP%\mc-w01`, probably
  waiting on the folder-trust prompt. Next step: accept trust, pair the board
  (`npm run mc -- open`), minimize MC-W01, click RESTORE (W-01).
- `sessions.json` holds a stale `MC-01` fixture session from an earlier run (`C:Fixturesproject`);
  DISMISS it on the board.
- WSL Ubuntu-26.04: packages installed, clone at `~/wt/mc-gate`; npm comes with WSL's Node (the old
  `~/bin/pnpm` wrapper is no longer needed since D-60). Run the Linux gate as
  `env -u WAYLAND_DISPLAY xvfb-run -n 99 dbus-run-session -- bash -c 'openbox & sleep 1; npm run gate'`.

## W- checklist order (docs/platforms/windows.md 9)

W-01 WT single tab; W-03 conhost; W-02 WT three tabs; W-07 no toast when in front; W-05 toast
click (also blocker 2; fall back to `mc install uri-handler --direct` if it only flashes);
W-04 and W-06 VS Code; W-08 Firefox; W-09 virtual desktop 2; W-10 elevated WT.

## Not blocking

- Blink off-phase contrast (design call).
- Rename `@mc/vscode-bridge` to `vscode-bridge` before packaging a .vsix (D-30).
- Codex computer-use program under the chain never seen starting; Copilot permission prompts
  not exercised with a real agent.
- `typecheck` skips `test/` files; eight 401s before pairing.
- macOS MO-01..06 need a Mac.
