# Tasks

The build as 36 tasks for Haiku-class builders. A builder reads `AGENTS.md`, its task
file `docs/tasks/T###.md`, and the contracts the task file lists. Nothing else.
`docs/ORCHESTRATION.md` says how they are run.

Every task's acceptance command is `npm run task:check T###` (TEST-PLAN 2.4) unless the
task file says otherwise (T001 and T004 build the checker itself). Every milestone ends
in `npm run gate:mN`; the project ends in `npm run gate`.

## Milestones

| Milestone | Delivers | Tasks | Gate |
|---|---|---|---|
| M0 Foundation | monorepo, frozen contracts as code, fake platform, gate runner | T001, T004, T002, T003 | `npm run gate:m0` |
| M1 Daemon | core logic, daemon, hook; sessions appear over the API with a fake platform | T010-T016, T020-T027 | `npm run gate:m1` |
| M2 Console | the mission-control page, e2e against the real daemon | T030-T033 | `npm run gate:m2` |
| M3 Platforms | real discovery, focus and notifications on Windows, macOS, Linux | T040-T046 | `npm run gate:m3` (per OS) |
| M4 Integration | `mc` CLI, installers, VS Code bridge, shell integration, system e2e | T050-T054 | `npm run gate:m4` |
| M5 Release | budget, final audit, user guide, validation templates | T060 | `npm run gate` |
| M5 packaging | the `mission-control-desktop` tarball and `.vsix`, layout module, launchers, repair, release, fresh-machine proof (D-39..D-46, `docs/PACKAGING.md`) | T080-T098 | `npm run gate` (stage `package`) + FM-01..FM-08 |

## Waves (tasks in one wave run in parallel; no two write the same file)

| Wave | Tasks | Starts when |
|---|---|---|
| 0a | T001 | plan frozen |
| 0b | T004 | T001 merged |
| 0c | T002 | T004 merged |
| 0d | T003 | T002 merged; then tag `m0` after `npm run gate:m0` |
| 1 | T010, T011, T012, T013, T014, T015, T016, T030, T031, T032 | `m0` |
| 2 | T020, T021, T022, T023, T024, T025, T040, T041, T042, T043, T044, T045, T046 | all of wave 1 merged |
| 3 | T026 | T014, T015, T021-T025 merged |
| 4 | T027 | T026, T020 merged; then `npm run gate:m1`, tag `m1` |
| 5 | T033, T050, T051, T052, T053 | `m1`; T033 also needs T030-T032 |
| 6 | T054, T060 | wave 5 merged (`m2` tagged after T033, `m3` after wave 2's platform tasks pass on each OS, `m4` after T054) |
| 7 | T070, T072 | `m4` (real agent runs) |
| 8a | T080 | packaging plan frozen (`docs/PACKAGING.md`) |
| 8b | T081 | T080 merged (T080 commits the lock change for root esbuild; the orchestrator re-runs `npm install` on a lock conflict) |
| 8c | T082, T083 | T081 merged |
| 8d | T084, T086 | T083 merged (T084 merges right after T083: claude, copilot and codex write launchers only from T084) |
| 8e | T085 | T084 merged |
| 8f | T087, T092 | T082-T086 merged (T092 needs T085 and T086 specifically; it edits `main.ts` after T085) |
| 8g | T088, T093, then T089; T094 | T087 and T092 merged; T089 reruns after T093 (D-47) |
| 8h | T090 | T088, T089 merged; `npm run gate` with stage `package` on Windows and Linux |
| 8i | T091 | Woody has run FM-01..FM-08 in Windows Sandbox |
| 10a | T119 | wave 9 merged (D-58) |
| 10b | T120, T121, T122 | T119 merged |
| 10c | T123 | T120-T122 merged; then `npm run gate` |
| 11 | T124 | wave 10 merged (D-59); then `npm run gate` |
| 12 | T125 | wave 11 merged (D-61); then `npm run gate` |

Wave 2 platform tasks run on their OS: T040-T042 on dev-pc (Windows), T045-T046 in
a Linux environment (WSL2 Ubuntu on dev-pc is enough: the OS tests use Xvfb),
T043-T044 on a Mac if one is available, else on any OS with only their `any` IDs
checked (TEST-PLAN 2.4) and the macOS rows marked unverified.

## Task table

| ID | Title | M | Wave | Depends | Owns (create or modify only these) | Runs on |
|---|---|---|---|---|---|---|
| T001 | Monorepo scaffold and stubs | M0 | 0a | - | root config files, every `packages/*/package.json` + `tsconfig.json`, every stub in `contracts/internal.md` 4, `packages/daemon/src/internal.ts`, `packages/ui/src/model.ts`, `packages/ui/{index.html,vite.config.ts}`, `playwright.config.ts`, `scripts/check-toolchain.mjs`, `scripts/check-stubs.mjs` | any |
| T004 | Gate runner, task check, test-ID audit, CI workflow | M0 | 0b | T001 | `scripts/gate.mjs`, `scripts/gates.json`, `scripts/task-check.mjs`, `scripts/check-test-ids.mjs`, `scripts/test-ids.json`, `scripts/lib/*.mjs`, `scripts/test/**`, `.gitea/workflows/gate.yml` | any |
| T002 | `@mc/contracts`: schemas, types, validators, fixtures | M0 | 0c | T004 | `packages/contracts/**` (except `package.json`, `tsconfig.json`) | any |
| T003 | `@mc/platform` types, exec, fake, conformance, selection | M0 | 0d | T002 | `packages/platform/src/{types,exec,index}.ts`, `packages/platform/src/fake/**`, `packages/platform/src/null.ts`, `packages/platform/test/{conformance.ts,fake.test.ts}` | any |
| T010 | Attention reducer | M1 | 1 | M0 | `packages/core/src/attention.ts`, `packages/core/src/summary.ts`, `packages/core/test/attention.test.ts`, `packages/core/test/helpers.ts` | any |
| T011 | Notify policy and coalescer | M1 | 1 | M0 | `packages/core/src/notify-policy.ts`, `packages/core/test/notify-policy.test.ts` | any |
| T012 | Host classification and callsigns | M1 | 1 | M0 | `packages/core/src/classify.ts`, `packages/core/src/callsign.ts`, `packages/core/test/classify.test.ts` | any |
| T013 | Process utilities (ancestry, liveness, tty) | M1 | 1 | M0 | `packages/platform/src/process/**`, `packages/platform/test/process.test.ts`, `packages/platform/test/fixtures/process/**` | any |
| T014 | Paths and config store | M1 | 1 | M0 | `packages/daemon/src/{paths,config}.ts`, `packages/daemon/test/config.test.ts`, `packages/daemon/test/fixtures/paths.json` | any |
| T015 | Auth and security middleware | M1 | 1 | M0 | `packages/daemon/src/{auth,security}.ts`, `packages/daemon/test/security.test.ts` | any |
| T016 | Persistence (snapshot, event log, spool) | M1 | 1 | M0 | `packages/daemon/src/persistence.ts`, `packages/daemon/test/persistence.test.ts` | any |
| T020 | `mc-hook` (Claude Code, Codex, shell) | M1 | 2 | T013 | `packages/hook/src/**`, `packages/hook/test/**` | any |
| T021 | SessionService | M1 | 2 | T010, T012, T016 | `packages/daemon/src/sessions.ts`, `packages/daemon/test/sessions.test.ts` | any |
| T022 | VS Code bridge registry (daemon side) | M1 | 2 | T003 | `packages/daemon/src/bridge.ts`, `packages/daemon/test/bridge.test.ts` | any |
| T023 | Notifier | M1 | 2 | T011, T003 | `packages/daemon/src/notifier.ts`, `packages/daemon/test/notifier.test.ts` | any |
| T024 | FocusService and target resolution | M1 | 2 | T003, T012 | `packages/daemon/src/focus.ts`, `packages/daemon/test/focus.test.ts` | any |
| T025 | Liveness and git info | M1 | 2 | T003 | `packages/daemon/src/{liveness,git}.ts`, `packages/daemon/test/{liveness,git}.test.ts` | any |
| T026 | HTTP app: routes, WebSocket, test routes | M1 | 3 | T014, T015, T021-T025 | `packages/daemon/src/app.ts`, `packages/daemon/src/routes/**`, `packages/daemon/src/ws.ts`, `packages/daemon/test/{api,ws}.test.ts`, `packages/daemon/test/support/**` | any |
| T027 | Daemon entry, single instance, integration tests | M1 | 4 | T026, T020 | `packages/daemon/src/main.ts`, `packages/daemon/src/bin.ts`, `packages/daemon/test/integration/**`, `packages/daemon/test/budget.test.ts` | any |
| T030 | UI shell: tokens, fonts, bar, banners, empty state | M2 | 1 | M0 | `packages/ui/src/{main.tsx,App.tsx,tokens.css,global.css}`, `packages/ui/src/components/{Bar,Banner,Empty}.tsx`, `packages/ui/test/shell.test.tsx` | any |
| T031 | UI card, lamps, formatting | M2 | 1 | M0 | `packages/ui/src/components/{Card,Lamp}.tsx`, `packages/ui/src/{card.css,format.ts}`, `packages/ui/test/card.test.tsx`, `packages/ui/test/fixtures.ts` | any |
| T032 | UI data layer, board, poll strip, counts | M2 | 1 | M0 | `packages/ui/src/{store,api,sort}.ts`, `packages/ui/src/components/{Board,PollStrip,Counts}.tsx`, `packages/ui/src/board.css`, `packages/ui/test/store.test.tsx` | any |
| T033 | E2E suite (golden path, card, design, a11y) | M2 | 5 | T027, T030-T032 | `e2e/{golden-path,card,design,a11y}.spec.ts`, `e2e/support/**`, `e2e/__screenshots__/**` | any |
| T040 | Windows discovery, win32 bindings, adapter assembly | M3 | 2 | T003, T013 | `packages/platform/src/windows/{index,discover,win32}.ts`, `packages/platform/test/windows-discover.test.ts`, `packages/platform/test/os/windows-discover.os.test.ts`, `packages/platform/test/fixtures/windows/**` | Windows |
| T041 | Windows focus, foreground, WT tabs | M3 | 2 | T003 | `packages/platform/src/windows/focus.ts`, `packages/platform/src/windows/ps/wt-*.ps1`, `packages/platform/test/windows-focus.test.ts`, `packages/platform/test/os/windows-focus.os.test.ts` | Windows |
| T042 | Windows toasts and registration | M3 | 2 | T003 | `packages/platform/src/windows/notify.ts`, `packages/platform/src/windows/ps/toast-host.ps1`, `packages/platform/src/windows/{registry,toast-host}.ts`, `packages/platform/assets/icon-256.png`, `packages/platform/test/windows-notify.test.ts`, `packages/platform/test/os/windows-notify.os.test.ts` | Windows |
| T043 | macOS discovery and focus | M3 | 2 | T003, T013 | `packages/platform/src/macos/{index,discover,focus}.ts`, `packages/platform/src/macos/scripts/**` (except `notify-*`), `packages/platform/test/macos-focus.test.ts`, `packages/platform/test/os/macos-focus.os.test.ts`, `packages/platform/test/fixtures/macos/**` | macOS (else any) |
| T044 | macOS notifications | M3 | 2 | T003 | `packages/platform/src/macos/notify.ts`, `packages/platform/src/macos/scripts/notify-*`, `packages/platform/test/macos-notify.test.ts`, `packages/platform/test/os/macos-notify.os.test.ts` | macOS (else any) |
| T045 | Linux discovery and focus (X11, sway, Hyprland, KWin, GNOME, tmux) | M3 | 2 | T003, T013 | `packages/platform/src/linux/{index,discover,focus,backends/*,tmux}.ts`, `packages/platform/test/linux-backends.test.ts`, `packages/platform/test/os/linux-x11.os.test.ts`, `packages/platform/test/fixtures/linux/**` | Linux |
| T046 | Linux notifications (D-Bus) | M3 | 2 | T003 | `packages/platform/src/linux/notify.ts`, `packages/platform/src/linux/dbus-service.ts`, `packages/platform/test/linux-notify.test.ts`, `packages/platform/test/os/linux-notify.os.test.ts` | Linux |
| T050 | `mc` CLI: start, stop, status, daemon, open, restore, token, doctor | M4 | 5 | T027 | `packages/cli/src/{main,mc}.ts`, `packages/cli/src/commands/{start,stop,status,daemon,open,restore,token,doctor}.ts`, `packages/cli/src/lib/**`, `packages/cli/test/{cli,doctor}.test.ts` | any |
| T051 | Installers: claude-code, codex, shell, uri-handler, autostart, vscode | M4 | 5 | T027 | `packages/cli/src/commands/{install,uninstall}.ts`, `packages/cli/src/installers/**`, `packages/cli/test/{install-claude,install-other}.test.ts`, `packages/cli/test/fixtures/**` | any |
| T052 | VS Code bridge extension | M4 | 5 | T027 | `packages/vscode-bridge/src/**`, `packages/vscode-bridge/test/**`, `packages/vscode-bridge/README.md` | any |
| T053 | Shell integration snippets | M4 | 5 | T020 | `packages/cli/assets/shell/**`, `packages/cli/test/shell-integration.test.ts` | any |
| T054 | System e2e through real processes | M4 | 6 | T050-T053 | `e2e/system.spec.ts`, `e2e/system-support/**` | any |
| T072 | Codex fixes from the real run (notify chaining, title thread, pair-code body) | M4 | 7 | T020, T026, T051 | `packages/hook/src/codex.ts`, `packages/cli/src/installers/codex.ts`, `packages/daemon/src/routes/api.ts` | any |
| T060 | Release: user guide, validation templates, final audit | M5 | 6 | T050-T053 | `docs/USER-GUIDE.md`, `docs/validation/TEMPLATE-*.md` | any |
| T070 | Copilot CLI adapter: `mc-hook copilot-cli`, `mc install copilot` | M4 | 7 | T051 | `packages/hook/src/copilot.ts`, `packages/cli/src/installers/copilot.ts`, `packages/hook/test/copilot.test.ts`, `packages/core/test/copilot.test.ts`, `packages/cli/test/install-copilot.test.ts` | any |
| T080 | Manifests and version source: version 1.0.0, `scripts/version.mjs`, platform `./layout` export and asset copy, bridge renamed `vscode-bridge` | M5 | 8a | - | root `package.json`, `packages/*/package.json`, `scripts/version.mjs`, `scripts/copy-platform-assets.mjs`, `scripts/test/version.test.mjs`, `packaging-test/version-build.test.mjs`, `vitest.workspace.ts` (alias and `packaging` project) | any |
| T081 | Layout module `@mc/platform/layout` | M5 | 8b | T080 | `packages/platform/src/layout.ts`, `packages/platform/test/layout.test.ts` | any |
| T082 | Rewire platform and daemon consumers to `layout()` | M5 | 8c | T081 | `packages/platform/src/windows/{notify,focus}.ts`, `packages/platform/src/linux/notify.ts`, `packages/platform/src/macos/{discover,notify}.ts`, `packages/daemon/src/main.ts`, `packages/daemon/test/layout-wiring.test.ts` | any |
| T083 | Launchers and installer paths | M5 | 8c | T081 | `packages/cli/src/installers/{launcher,manifest,uri,shell,autostart}.ts`, `packages/cli/test/{install-claude,install-other,install-launcher}.test.ts`, `packages/cli/test/fixtures/**`, `packages/cli/test/install-copilot.test.ts` (CP-10 path assertion only) | any |
| T084 | Repair in place: claude-code, copilot, codex | M5 | 8d | T083 | `packages/cli/src/installers/{claude,copilot,codex}.ts`, `packages/cli/test/install-repair.test.ts` | any |
| T085 | CLI lib in package mode: paths, koffi, --version, hook-paths, launcher self-heal | M5 | 8e | T083, T084 | `packages/cli/src/main.ts`, `packages/cli/src/lib/{paths,system,doctor-checks}.ts`, `packages/cli/src/commands/start.ts`, `packages/cli/test/package-cli.test.ts` | any |
| T086 | `mc install vscode` from the shipped .vsix | M5 | 8d | T080, T081, T083 | `packages/cli/src/installers/vscode.ts`, `packages/vscode-bridge/.vscodeignore`, `packages/cli/test/install-vscode-package.test.ts`, and in `packages/cli/test/install-other.test.ts` only the IX-08 `@mc/vscode-bridge` strings | any |
| T087 | `scripts/package.mjs`: npm package and .vsix | M5 | 8f | T082-T086 | `scripts/package.mjs`, `packaging-test/package.test.mjs`, `.gitignore`, `eslint.config.js` and `.prettierignore` (the `release` ignore entry only) | any |
| T088 | `scripts/release.mjs` and 1.0.0 release notes | M5 | 8g | T087, T092 | `scripts/release.mjs`, `RELEASE-NOTES.md`, `packaging-test/release.test.mjs` | any |
| T089 | Package-install smoke: tarball into a temp prefix, run `mc` (gate stage `package`) | M5 | 8g | T087 | `packaging-test/install.test.mjs`, `scripts/gates.json` | windows, linux |
| T090 | Fresh-machine proof in Windows Sandbox: `.wsb` generator, bootstrap script, FM checklist | M5 | 8h | T088, T089, T092 | `scripts/sandbox/{make-wsb.mjs,bootstrap.ps1}`, `scripts/test/sandbox.test.mjs` | windows |
| T091 | Packaging docs: user guide, PRD non-goal, fresh-machine record, handoff (orchestrator) | M5 | 8i | T090 | `docs/USER-GUIDE.md`, `docs/PRD.md`, `docs/validation/fresh-machine-windows-<date>.md`, `HANDOFF.md` | any |
| T092 | `mc init` (agent prompt, support installers) and `mc launch` | M5 | 8f | T085, T086 | `packages/cli/src/commands/{init,launch}.ts`, `packages/cli/test/init-launch.test.ts`, and in `packages/cli/src/main.ts` only the dispatch and help lines for `init` and `launch` | any |
| T093 | Bundle dbus-next so the tarball installs without building usocket (D-47) | M5 | 8g | T087 | `scripts/package.mjs`, `packaging-test/package.test.mjs` | any |
| T094 | Daemon-starting tests stop their daemon before deleting MC_HOME (leak fix) | M5 | 8g | T085, T092 | `packages/cli/test/package-cli.test.ts`, `packages/cli/test/init-launch.test.ts` | any |
| T095 | RW-08 passes whether or not the UI has been built (Linux gate stage order) | M5 | 8h | T082 | `packages/daemon/test/layout-wiring.test.ts` | any |
| T096 | Installed `mc` runs through npm's shim: shebang on every bin; SK uses the shims | M5 | 8h | T087, T089 | `scripts/package.mjs`, `packaging-test/package.test.mjs`, `packaging-test/install.test.mjs` | windows, linux |
| T097 | `mc init --agents` accepts the list as separate words (PowerShell splits a,b) | M5 | 8h | T092 | `packages/cli/src/commands/init.ts`, `packages/cli/test/init-launch.test.ts` | any |
| T098 | `mc init --agents` splits on whitespace too (npm's PowerShell shim joins a,b with a space) | M5 | 8h | T097 | `packages/cli/src/commands/init.ts`, `packages/cli/test/init-launch.test.ts` | any |
| T100 | The Terrain deck board (D-48) | M5 | 9 | T098 | `packages/ui/**`, `e2e/**`, `packages/core/src/notify-policy.ts` (plain words) | windows, linux |
| T101 | Installer commands that are not `.exe` run on Windows (cmd.exe quoting in `realRun`) | M5 | 8i | T083 | `packages/platform/src/exec.ts`, `packages/cli/src/installers/manifest.ts`, `packages/cli/test/install-run.test.ts` | windows |
| T102 | An elevated target window gets restore reason `target_elevated` with a fix-it text (D-49, W-10) | M5 | 8i | T040, T100 | `packages/platform/src/windows/discover.ts`, `packages/ui/src/format.ts`, `packages/contracts/**` (RestoreReason), `packages/ui/test/fix-text.test.tsx` | any |
| T103 | W- findings: conhost inside WT is classified conhost; doctor reads a missing notifications `Enabled` as on (D-50) | M5 | 8i | T012, T050 | `packages/core/src/classify.ts`, `packages/cli/src/lib/doctor-checks.ts` | any |
| T104 | Gate portability: RR-01 runs on every OS (Linux audit saw it skipped); RN-04 reports the release script output on failure | M5 | 8i | T101, T088 | `packages/cli/test/install-run.test.ts`, `packaging-test/release.test.mjs` | any |
| T105 | Terrain shows live sessions and fits its regions; empty note says `mc init` (D-51) | M5 | 8i | T100 | `packages/ui/src/terrain.ts`, `packages/ui/src/App.tsx`, `packages/ui/src/components/Board.tsx`, `packages/ui/src/components/Empty.tsx`, `packages/ui/test/terrain-fit.test.tsx`, `e2e/design.spec.ts` (DS-09), `e2e/__screenshots__/board-*.png` | any |
| T106 | Larger fleets keep the rolling ground; telemetry row only with the T preview (D-52) | M5 | 8i | T105 | `packages/ui/src/terrain.ts`, `packages/ui/src/App.tsx`, `packages/ui/test/terrain-fit.test.tsx`, `e2e/design.spec.ts` (DS-06, DS-09, TR-03 wait), `e2e/__screenshots__/board-*.png` | any |
| T107 | Unattended `mc init` connects the default agent, Copilot (D-53) | M5 | 8i | T092 | `packages/cli/src/commands/init.ts`, `packages/cli/test/init-launch.test.ts` (IN-04) | any |
| T108 | PK-01 keeps package.mjs output on failure (Linux gate saw it fail with nothing recorded) | M5 | 8i | T087 | `packaging-test/package.test.mjs` | any |
| T109 | Restore leaves keyboard focus in the terminal; tab rule matches Copilot and Codex (D-54) | M5 | 8i | T041 | `packages/platform/src/windows/ps/wt-select-tab.ps1`, `packages/platform/src/windows/focus.ts` (chooseTab), `packages/platform/test/windows-focus.test.ts` | any |
| T110 | The vsix is written outside the bridge package folder (vsce read its own output: intermittent ENOENT) | M5 | 8i | T087 | `scripts/package.mjs`, `packages/vscode-bridge/package.json` (package script), `packaging-test/version-build.test.mjs` (VR-14) | any |
| T111 | Release 1.0.1: version, notes, version tests read the root version | M5 | 8i | T088 | 9 `package.json` versions, `RELEASE-NOTES.md`, `scripts/test/version.test.mjs` (VR-01, VR-02), `packaging-test/version-build.test.mjs` (VR-14) | any |
| T112 | Copilot telemetry fold in core: events.jsonl lines and OTel records to `Telemetry` (D-56) | M5 | 9a | T002 | `packages/core/src/telemetry.ts`, `packages/core/src/index.ts` (export line), `packages/core/test/telemetry.test.ts`, `packages/core/test/fixtures/telemetry/*` | any |
| T113 | Daemon reads Copilot session logs and OTel files into `Session.telemetry` (D-56) | M5 | 9b | T112, T021, T027 | `packages/daemon/src/telemetry.ts`, `packages/daemon/src/sessions.ts` (setTelemetry), `packages/daemon/src/internal.ts` (setTelemetry line), `packages/daemon/src/main.ts` (telemetry wiring), `packages/daemon/test/telemetry.test.ts` | any |
| T114 | Daemon Copilot account service over the SDK: quota, plan, forecast in `DaemonInfo.copilot` (D-56) | M5 | 9c | T113, T115 | `packages/daemon/src/copilot-account.ts`, `packages/daemon/src/copilot-sdk-client.ts`, `packages/daemon/src/internal.ts` (DaemonDeps.copilot), `packages/daemon/src/routes/api.ts` (DaemonInfo.copilot), `packages/daemon/src/main.ts` (account wiring), `packages/daemon/package.json`, `package-lock.json`, `packages/daemon/test/copilot-account.test.ts`, `packages/daemon/test/support/deps.ts` (copilot stub) | any |
| T115 | `mc doctor copilot [--live]`: checks D1-D10 prove the SDK runtime on one PC (D-56) | M5 | 9a | T050 | `packages/cli/src/commands/doctor.ts` (copilot subcommand), `packages/cli/src/lib/doctor-copilot.ts`, `packages/cli/package.json`, `package-lock.json`, `packages/cli/test/doctor-copilot.test.ts` | any |
| T116 | Shell integration sets one Copilot OTel file per shell under `<stateDir>/otel` (D-56) | M5 | 9a | T053 | `packages/cli/src/installers/shell.ts` (shell.env text), `packages/cli/assets/shell/mc.ps1`, `mc.bash`, `mc.zsh`, `packages/cli/test/shell-integration.test.ts` (SH-06, SH-07) | any |
| T117 | Daemon keeps Copilot traces and spans per session; `GET /api/sessions/:id/traces` (D-57) | M5 | 9d | T113, T114 | `packages/daemon/src/traces.ts`, `packages/daemon/src/telemetry.ts` (addSpan call), `packages/daemon/src/routes/api.ts` (traces route), `packages/daemon/src/internal.ts` (DaemonDeps.traces), `packages/daemon/src/main.ts` (traces wiring), `packages/daemon/test/support/deps.ts` (traces stub), `packages/daemon/test/traces.test.ts` | any |
| T118 | Three older tests follow D-56: shell.env third line (IX-03, LN-10), SDK dependency (PK-03) | M5 | 9e | T114, T115, T116 | `packages/cli/test/install-other.test.ts` (IX-03), `packages/cli/test/install-launcher.test.ts` (LN-10), `packaging-test/package.test.mjs` (DEPENDENCY_NAMES) | any |
| T119 | UI telemetry helpers, hash routes and the traces client (D-58) | M5 | 10a | T117 | `packages/ui/src/telemetry-format.ts`, `packages/ui/src/route.ts`, `packages/ui/src/api.ts` (traces), `packages/ui/test/telemetry-fixtures.ts`, `packages/ui/test/telemetry-format.test.tsx` | any |
| T120 | The list view gets five sortable telemetry columns and an Open link (D-58) | M5 | 10b | T119 | `packages/ui/src/components/ListView.tsx`, `packages/ui/src/list-tele.css`, `packages/ui/test/list-tele.test.tsx` | any |
| T121 | The session page: key values, model calls, runs, tools, permissions, subagents (D-58) | M5 | 10b | T119 | `packages/ui/src/components/SessionView.tsx`, `packages/ui/src/session-view.css`, `packages/ui/test/session-view.test.tsx` | any |
| T122 | The run trace page: one agent run as a waterfall (D-58) | M5 | 10b | T119 | `packages/ui/src/trace-layout.ts`, `packages/ui/src/components/RunTrace.tsx`, `packages/ui/src/trace.css`, `packages/ui/test/trace-layout.test.tsx`, `packages/ui/test/run-trace.test.tsx` | any |
| T123 | Wire the session page and the run trace into the app; key O; sheet link (D-58) | M5 | 10c | T120, T121, T122 | `packages/ui/src/App.tsx`, `packages/ui/src/components/Details.tsx` (sheet-open), `packages/ui/src/components/Help.tsx` (O row), `packages/ui/test/routes.test.tsx` | any |
| T124 | `mc uninstall --all [--purge]`; the untested uninstalls get tests (D-59) | M5 | 11 | T118 | `packages/cli/src/commands/uninstall.ts`, `packages/cli/src/main.ts` (uninstall usage line), `packages/cli/test/uninstall-all.test.ts`, `packaging-test/install.test.mjs` (SK-08) | any |
| T125 | Claude Code telemetry and traces, AI Credits, the board on real data (D-61) | M5 | 12 | T124 | `packages/core/src/claude-telemetry.ts`, `packages/daemon/src/telemetry.ts`, `packages/ui/src/components/Telemetry.tsx` and the files in `docs/tasks/T125.md` | any |

Shared files with exactly one writer for the whole run (the orchestrator, after merge):
`package-lock.json` (builders may change it only by `npm install <dep> -w <their package>`,
and the orchestrator resolves lock conflicts by re-running `npm install` on the rebased
branch), `CHECKPOINT.md`, `docs/**` other than `docs/checkpoints/T###.md` and the T060
files, `scripts/test-ids.json` after T004.

Adding a dependency: only the packages pre-declared by T001 are allowed; a task that
needs another one stops with a CR.
