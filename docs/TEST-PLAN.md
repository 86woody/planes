# Test plan

## 1. Layers

| Layer | Tool | Where | Touches the OS? |
|---|---|---|---|
| Contract | Vitest + Ajv | `packages/contracts/test` | no |
| Unit | Vitest (node env; jsdom + Testing Library for `packages/ui`) | `packages/*/test` | no; platform code runs against recorded command outputs |
| Integration | Vitest, real daemon on port 0, `MC_HOME=<tmp>`, `MC_PLATFORM=fake`, real `mc-hook` processes | `packages/daemon/test/integration` | spawns processes only |
| E2E | Playwright (Chromium), real daemon with the fake platform, events injected through `/ingest/v1/events` or real `mc-hook` | `e2e/` | browser only |
| OS | Vitest with `MC_OS_TESTS=1`, real adapter for the current OS | `packages/platform/test/os/<os>*.os.test.ts` | yes: opens, minimizes and focuses test windows, raises test notifications |
| Manual | checklists W-, M-, L- | `docs/platforms/<os>.md` section 9/8/9, results in `docs/validation/<os>-<date>.md` | yes |

Rules: no skipped or `todo` tests anywhere (the audit fails on them); OS test files
(`*.os.test.ts`) belong only to the `platform-os` project and throw at load time unless
`MC_OS_TESTS=1` (so they can never silently skip); no test sleeps
more than 2 s; fake timers for every debounce, tick and timeout; every test that
spawns a process kills it in `afterEach`.

## 2. The gates

The gate runner is `scripts/gate.mjs` (T004), with the stage table in
`scripts/gates.json`. Root `package.json` scripts:

```
"gate":     "node scripts/gate.mjs m5",
"gate:m0":  "node scripts/gate.mjs m0",   ... "gate:m4": "node scripts/gate.mjs m4",
"task:check": "node scripts/task-check.mjs"
```

### 2.1 Stages

| Stage | Kind | Command (the runner adds reporters to vitest/playwright stages) | First in |
|---|---|---|---|
| toolchain | cmd | `node scripts/check-toolchain.mjs` (Node >= 22, npm >= 9, git; prints all three) | m0 |
| stubs | cmd | `node scripts/check-stubs.mjs` (every file in `contracts/internal.md` section 4 exists and exports its names) | m0 |
| typecheck | cmd | `npm run typecheck` | m0 |
| lint | cmd | `eslint . --max-warnings 0` | m0 |
| contracts | vitest | `vitest run --project contracts` | m0 |
| platform-fake | vitest | `vitest run --project platform-fake` | m0 |
| gate-self | vitest | `vitest run --project scripts` | m0 |
| core | vitest | `vitest run --project core` | m1 |
| daemon | vitest | `vitest run --project daemon` | m1 |
| hook | vitest | `npm run build -w @mc/contracts -w @mc/platform -w @mc/hook` then `vitest run --project hook` | m1 |
| integration | vitest | `npm run build -w @mc/contracts -w @mc/platform -w @mc/core -w @mc/hook -w @mc/daemon` then `vitest run --project daemon-integration` | m1 |
| ui-unit | vitest | `vitest run --project ui` | m2 |
| ui-build | cmd | `npm run build -w @mc/ui` | m2 |
| e2e | playwright | `playwright test e2e/golden-path.spec.ts e2e/card.spec.ts e2e/design.spec.ts e2e/a11y.spec.ts` | m2 |
| platform-unit | vitest | `vitest run --project platform` | m3 |
| os | vitest | `MC_OS_TESTS=1 vitest run --project platform-os` (the project includes only the current OS's files) | m3 |
| cli | vitest | `vitest run --project cli` | m4 |
| vscode | vitest | `vitest run --project vscode-bridge` | m4 |
| system | playwright | `npm run build` then `playwright test e2e/system.spec.ts` | m4 |
| budget | vitest | `vitest run --project budget` | m5 |
| package | vitest | `npm run build`, `npm run package`, then `vitest run --project packaging` (needs npm registry access) | m5 |
| audit | cmd | `node scripts/check-test-ids.mjs --gate <name>` | m0 (always last) |

The runner puts `node_modules/.bin` first on PATH, so bare `vitest`, `eslint` and
`playwright` resolve to the repo's own install (D-60).

Gate `mN` runs every stage whose "First in" is `<= mN`, in table order, `audit` last.
All stages run even after a failure (so one run shows every problem), except that a
`toolchain` failure stops the run.

### 2.2 Output and exit (falsifiable)

```
STAGE toolchain PASS 140ms  node v24.15.0 npm 11.12.1 git 2.53.0
STAGE stubs PASS 300ms
STAGE typecheck FAIL 8123ms
  | packages/core/src/attention.ts(41,7): error TS2322 ...      (last 30 lines of output, indented with "  | ")
...
STAGE audit PASS 210ms  ids 212/212 (os=windows), skipped 0
GATE m1 FAIL 10/11
```

Exit code 0 if and only if the last line is `GATE <name> PASS n/n`. Reports land in
`.gate/reports/<stage>.json` (git-ignored).

### 2.3 The audit

`scripts/test-ids.json` (T004 writes it from section 4 of this file, expanding ranges)
maps every test ID to `{task, milestone, os, file, runner}`. `check-test-ids.mjs --gate
mN` reads the JSON reports and fails if: any ID with milestone `<= mN` and os `any` or
the current OS has no test whose title starts with `<ID> ` (ID, then a space) with
status `passed`; any test anywhere has status `skipped`, `pending` or `todo`; any test
title starts with an ID-shaped token not in the registry. Output line:
`ids <found>/<required> (os=<os>), skipped <k>`.

### 2.4 Task check (every builder's acceptance command)

`npm run task:check T0xx` runs, for the task's IDs, the files listed in the registry (one
vitest or playwright invocation per runner, JSON reporter to `.gate/task-T0xx.json`),
then checks every ID of that task passed. Last line:
`TASK T0xx PASS <n>/<n>` (exit 0) or `TASK T0xx FAIL <k>/<n> missing: <ids>` (exit 1).
Files under `packages/platform/test/os/` are run with `MC_OS_TESTS=1` set.
Tasks with OS-specific IDs check only the IDs for the current OS plus `any`, and print
`(os=<os>, <m> ids for other OSes not checked)`.

## 3. Vitest projects (`vitest.config.ts` `test.projects`, T001; a workspace file until Vitest 5, D-62)

| Project | include | environment |
|---|---|---|
| contracts | `packages/contracts/test/**/*.test.ts` | node |
| platform-fake | `packages/platform/test/fake.test.ts` | node |
| platform | `packages/platform/test/**/*.test.ts` excluding `os/**` and `fake.test.ts` | node |
| platform-os | `packages/platform/test/os/<windows\|macos\|linux>*.os.test.ts` chosen by `process.platform` | node, `testTimeout: 20000`, `fileParallelism: false` |
| core | `packages/core/test/**/*.test.ts` | node |
| daemon | `packages/daemon/test/**/*.test.ts` excluding `integration/**` and `budget.test.ts` | node |
| daemon-integration | `packages/daemon/test/integration/**/*.test.ts` | node, `testTimeout: 15000` |
| budget | `packages/daemon/test/budget.test.ts` | node |
| hook | `packages/hook/test/**/*.test.ts` | node |
| cli | `packages/cli/test/**/*.test.ts` | node |
| ui | `packages/ui/test/**/*.test.tsx` | jsdom |
| vscode-bridge | `packages/vscode-bridge/test/**/*.test.ts` | node, `vscode` module aliased to `packages/vscode-bridge/test/vscode-mock.ts` |
| scripts | `scripts/test/**/*.test.mjs` | node |
| packaging | `packaging-test/**/*.test.mjs` (SK, PK, RN) | node, `testTimeout: 600000` (created by T080) |

The `packaging` project needs `release/` (from `npm run package`) and npm registry access, so
a bare `npm run test` or `vitest run` without `--project` runs it and fails on a fresh tree.
Gate stages always pass `--project`.

## 4. Test ID registry

`ID range | task | file | os`. Each ID is one test; the title is `<ID> <description>`.
Descriptions for SM and NP are the rows of `contracts/attention.md`; for others, the
task file lists them.

| IDs | Task | File | OS |
|---|---|---|---|
| CT-01..CT-08 | T002 | `packages/contracts/test/contracts.test.ts` | any |
| FK-01..FK-08 | T003 | `packages/platform/test/fake.test.ts` | any |
| GT-01..GT-06 | T004 | `scripts/test/gate.test.mjs` | any |
| SM-01..SM-28, SM-30..SM-38 | T010 | `packages/core/test/attention.test.ts` | any |
| NP-01..NP-14 | T011 | `packages/core/test/notify-policy.test.ts` | any |
| CL-01..CL-16 | T012 | `packages/core/test/classify.test.ts` | any |
| PR-01..PR-08 | T013 | `packages/platform/test/process.test.ts` | any |
| CF-01..CF-10 | T014 | `packages/daemon/test/config.test.ts` | any |
| SEC-01..SEC-15 | T015 | `packages/daemon/test/security.test.ts` | any |
| PS-01..PS-03 | T016 | `packages/daemon/test/persistence.test.ts` | any |
| HK-01..HK-11 | T020 | `packages/hook/test/hook.test.ts` | any |
| CX-01..CX-03 | T020 | `packages/hook/test/codex.test.ts` | any |
| SS-01..SS-10 | T021 | `packages/daemon/test/sessions.test.ts` | any |
| BR-01..BR-08 | T022 | `packages/daemon/test/bridge.test.ts` | any |
| NT-01..NT-08 | T023 | `packages/daemon/test/notifier.test.ts` | any |
| FO-01..FO-10 | T024 | `packages/daemon/test/focus.test.ts` | any |
| LV-01..LV-04 | T025 | `packages/daemon/test/liveness.test.ts` | any |
| GI-01..GI-03 | T025 | `packages/daemon/test/git.test.ts` | any |
| API-01..API-13 | T026 | `packages/daemon/test/api.test.ts` | any |
| WS-01..WS-06 | T026 | `packages/daemon/test/ws.test.ts` | any |
| IT-01..IT-06 | T027 | `packages/daemon/test/integration/daemon.test.ts` | any |
| PS-04..PS-05 | T027 | `packages/daemon/test/integration/persistence.test.ts` | any |
| BG-01 | T027 (milestone m5: the `budget` stage first runs in m5) | `packages/daemon/test/budget.test.ts` | any |
| UB-01..UB-07 | T030 | `packages/ui/test/shell.test.tsx` | any |
| UC-01..UC-12 | T031 | `packages/ui/test/card.test.tsx` | any |
| US-01..US-11 | T032 | `packages/ui/test/store.test.tsx` | any |
| GP-01..GP-08 | T033 | `e2e/golden-path.spec.ts` | any |
| CARD-01..CARD-04 | T033 | `e2e/card.spec.ts` | any |
| DS-01..DS-10 | T033 | `e2e/design.spec.ts` | any |
| AX-01..AX-04 | T033 | `e2e/a11y.spec.ts` | any |
| WU-01..WU-06 | T040 | `packages/platform/test/windows-discover.test.ts` | any |
| WO-01, WO-05, WO-08 | T040 | `packages/platform/test/os/windows-discover.os.test.ts` | windows |
| WU-07..WU-12 | T041 | `packages/platform/test/windows-focus.test.ts` | any |
| WO-02..WO-04, WO-07 | T041 | `packages/platform/test/os/windows-focus.os.test.ts` | windows |
| WU-13..WU-18 | T042 | `packages/platform/test/windows-notify.test.ts` | any |
| WO-06 | T042 | `packages/platform/test/os/windows-notify.os.test.ts` | windows |
| MU-01..MU-08 | T043 | `packages/platform/test/macos-focus.test.ts` | any |
| MO-01..MO-04, MO-06 | T043 | `packages/platform/test/os/macos-focus.os.test.ts` | macos |
| MU-09..MU-12 | T044 | `packages/platform/test/macos-notify.test.ts` | any |
| MO-05 | T044 | `packages/platform/test/os/macos-notify.os.test.ts` | macos |
| LU-01..LU-10 | T045 | `packages/platform/test/linux-backends.test.ts` | any |
| LO-01..LO-04, LO-06, LO-07 | T045 | `packages/platform/test/os/linux-x11.os.test.ts` | linux |
| LU-11..LU-14 | T046 | `packages/platform/test/linux-notify.test.ts` | any |
| LO-05 | T046 | `packages/platform/test/os/linux-notify.os.test.ts` | linux |
| CLI-01..CLI-10 | T050 | `packages/cli/test/cli.test.ts` | any |
| DR-01..DR-06 | T050 | `packages/cli/test/doctor.test.ts` | any |
| IC-01..IC-08 | T051 | `packages/cli/test/install-claude.test.ts` | any |
| IX-01..IX-08 | T051 | `packages/cli/test/install-other.test.ts` | any |
| VB-01..VB-08 | T052 | `packages/vscode-bridge/test/extension.test.ts` | any |
| SH-01..SH-05 | T053 | `packages/cli/test/shell-integration.test.ts` | any |
| SYS-01..SYS-06 | T054 | `e2e/system.spec.ts` | any |
| VR-01..VR-10, VR-12, VR-15, VR-16 | T080 | `scripts/test/version.test.mjs` | any |
| VR-11, VR-13, VR-14 | T080 | `packaging-test/version-build.test.mjs` | any |
| LY-01..LY-12 | T081 | `packages/platform/test/layout.test.ts` | any |
| RW-01..RW-09 | T082 | `packages/daemon/test/layout-wiring.test.ts` | any |
| LN-01..LN-13 | T083 | `packages/cli/test/install-launcher.test.ts` | any |
| RP-01..RP-14 | T084 | `packages/cli/test/install-repair.test.ts` | any |
| PC-01..PC-13 | T085 | `packages/cli/test/package-cli.test.ts` | any |
| VX-01..VX-08 | T086 | `packages/cli/test/install-vscode-package.test.ts` | any |
| PK-01..PK-08 | T087 | `packaging-test/package.test.mjs` | any |
| PK-09 | T093 | `packaging-test/package.test.mjs` | any |
| LK-01 | T094 | `packages/cli/test/package-cli.test.ts` | any |
| LK-02 | T094 | `packages/cli/test/init-launch.test.ts` | any |
| PK-10, SK-07 | T096 | `packaging-test/package.test.mjs`, `packaging-test/install.test.mjs` | any |
| IN-13 | T097 | `packages/cli/test/init-launch.test.ts` | any |
| IN-14 | T098 | `packages/cli/test/init-launch.test.ts` | any |
| RR-01 | T101, T104 | `packages/cli/test/install-run.test.ts` | any |
| EL-01 | T102 | `packages/ui/test/fix-text.test.tsx` | any |
| EL-02 | T102 | `packages/platform/test/windows-discover.test.ts` | any |
| CL-17 | T103 | `packages/core/test/classify.test.ts` | any |
| DR-07 | T103 | `packages/cli/test/doctor.test.ts` | any |
| TV-01..TV-03 | T105 | `packages/ui/test/terrain-fit.test.tsx` | any |
| TV-04, TV-05 | T106 | `packages/ui/test/terrain-fit.test.tsx` | any |
| WU-19, WU-20 | T109 | `packages/platform/test/windows-focus.test.ts` | any |
| RN-01..RN-05 | T088 | `packaging-test/release.test.mjs` | any |
| SK-01..SK-06 | T089 | `packaging-test/install.test.mjs` | any |
| SB-01..SB-10 | T090 | `scripts/test/sandbox.test.mjs` | any |
| IN-01..IN-12 | T092 | `packages/cli/test/init-launch.test.ts` | any |

Milestone of each ID = the milestone of its task (`docs/TASKS.md`), except where a row
names another one.

## 5. CI matrix

The forge (`platform/homelab/forge/README.md` in the workspace) has a Linux runner
only. Plan:

| Runner | Gate | Notes |
|---|---|---|
| forge Linux (Gitea Actions), `.gitea/workflows/gate.yml` (T004) | `xvfb-run -a dbus-run-session -- npm run gate` | installs `wmctrl x11-utils xdotool xterm openbox tmux`; starts `openbox &` inside xvfb before the gate; Playwright Chromium with `--with-deps` |
| dev-pc (Windows 11), by hand | `npm run gate` from an interactive session | log saved to `docs/validation/gate-windows-<date>.log`; test windows will appear and move for ~30 s |
| a Mac (PRD Q4), by hand | `npm run gate` | Automation not granted: MO-03 takes the denied branch; log to `docs/validation/gate-macos-<date>.log` |

A GitHub Actions matrix (`windows-2022`, `macos-14`, `ubuntu-24.04`) is the intended
replacement if the repo is ever mirrored there; the workflow file is not written in v1.

## 6. Manual checklists

The rows are in the platform docs: Windows W-01..W-10 (`platforms/windows.md` 9),
macOS M-01..M-07 (`platforms/macos.md` 8), Linux L-01..L-07
(`platforms/linux.md` 9). Each run is a file `docs/validation/<os>-<date>.md` with one
line per row: `ID | PASS/FAIL | note`, written by Woody (or an agent watching with him).
Release v1 requires: `npm run gate` PASS logs on Windows and Linux, the W- checklist all
PASS except rows the platform docs mark as degraded-by-design, and the macOS rows either
PASS or listed under "unverified" in the release notes.

Fresh-machine proof (T090, D-45), run in Windows Sandbox on dev-pc and recorded by
Woody in `docs/validation/fresh-machine-windows-<date>.md` (T091). Manual rows, not in
`scripts/test-ids.json`:

| ID | Do | Expect |
|---|---|---|
| FM-01 | On dev-pc, `Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM` | `State : Enabled` (else enable it and reboot, then record) |
| FM-02 | Double-click `release/sandbox/mc.wsb` | the Sandbox boots and a PowerShell window starts `bootstrap.ps1` |
| FM-03 | Watch the `node-install` step | `summary.txt` has `STEP node-install PASS`; `node --version` prints `v22.x` |
| FM-04 | Watch the `package-install` step | `STEP package-install PASS`; `npm i -g` of the tarball finishes with no error |
| FM-05 | Read the `mc-version` step in `C:\mc-results\transcript.txt` | `mc --version` prints the tarball's version |
| FM-06 | In the sandbox, open `%USERPROFILE%\.claude\settings.json` after `mc-init` | nine mc hook groups, each `args[0]` ending `state\bin\mc-hook.js` (forward slashes), `args[1]` = `claude-code` |
| FM-07 | After `mc-launch` and `hook-event`, look at the browser page | the board opens (paired) and shows the card for session `fm-1` |
| FM-08 | Minimize the `MC-FM` PowerShell window; press RESTORE on the card | the `MC-FM` window comes to the front (chip FOCUSED, WINDOW ONLY or FLASHED recorded in the note) |

## 7. What each acceptance criterion rests on

See PRD section 7: every AC names its test IDs; the audit (2.3) guarantees those tests
exist and pass for the gate that includes them.
