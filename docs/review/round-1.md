# Review round 1

Reviewer: adversarial reviewer (Claude). Date: 2026-11-08. Branch `plan/specs` at
`fe9ba14` plus this round's commit.

## Verdict: APPROVE-WITH-CHANGES

The plan delivers the ask. Every requirement has an acceptance criterion: cards (AC-01,
AC-02), RESTORE + maximize per host and OS (AC-06..AC-08), OS notifications and their
clicks (AC-04, AC-05, AC-09), three OSes, the theme (AC-16), and local-only security
(AC-10). Where an OS forbids an action, the plan degrades honestly and says so on the
card: Wayland `none`, GNOME without the extension, macOS without Automation, elevated
Windows windows. Contracts, a fake platform, a test-ID audit and per-task `task:check`
gates make it fit for Haiku builders. Most cross-references check out. I checked them
by script: every task's expected `PASS n/n` equals its titled IDs and the TEST-PLAN
registry.

I found three blockers. The first two I fixed in the docs (F1, F2). The third (F3)
needs an author decision. Several majors would have stalled a Haiku builder at
`task:check` with no legal fix, or were wrong about current Claude Code or macOS
behaviour. I fixed all of those that are not judgement calls. I would approve once F3
is resolved, F16 is decided by Woody, and the author has answered F17 and F24.

I simulated a Haiku builder on these tasks, reading only CLAUDE.md, the contracts and
the task file: T001, T002, T003, T004 (wave 0), T010, T013, T014, T015 (wave 1), T020,
T021, T022, T023, T024, T025, T040, T041, T042 (wave 2), T026 (wave 3), T027 (wave 4),
T030, T032 (wave 1 UI), T033, T050, T051, T052 (wave 5), and T045 and T046
(acceptance commands only).

I verified these claims against sources:
- code.claude.com/docs/en/hooks, read 2026-11-08: `async`, `shell`, exec form `args`,
  the `notification_type` values, the StopFailure fields, and the 1.5 s SessionEnd
  budget.
- Apple Developer Forums threads on macOS 14 activation:
  https://developer.apple.com/forums/thread/739524 and
  https://developer.apple.com/forums/thread/807805.
- The TypeScript `rootDir` rule.
- The local toolchain (`pnpm --version` = 11.2.2, Node 24.15.0).
- The repo state (`main` already exists).

## Findings

Severity: **blocker** = review README "high"; **major** = "medium"; **minor** = "low".
"Changed" means I edited the docs in this round's commit. "Required" means the author
(or Woody) must act.

| F | Severity | Location | Problem | Action |
|---|---|---|---|---|
| F1 | blocker | `tasks/T001.md` steps 3-4 | `tsconfig.base.json` maps `@mc/<p>` to `packages/<p>/src/index.ts` through `paths`, and every package sets `rootDir: src`. The first stub that imports another package (`daemon/src/internal.ts` imports `@mc/contracts`, `@mc/core` and `@mc/platform`) pulls a file outside `rootDir` into the program. `tsc` then fails with TS6059, so T001's own acceptance command fails, and so does every later typecheck. A Haiku builder cannot fix this: T001 owns the config but the task file dictates `paths`. | **Changed.** No `paths` or `baseUrl`. Packages are `composite` with `references` to their `@mc/*` deps. The root `tsconfig.json` is a solution file. `build`/`typecheck` = `tsc -b` (topological through `pnpm -r`). `ui` and `vscode-bridge` are non-composite with `tsc --noEmit`, because a `tsc` emit would overwrite the esbuild bundle in `vscode-bridge/dist`. Vitest still uses its `resolve.alias`. |
| F2 | blocker | `ingest.schema.json` `sentAt`, `tasks/T020.md` step 4, `attention.md` 3 | `sentAt = Date.now()` is stamped after Node start-up and the ancestry walk, which take 60-300 ms with jitter. Two events Claude Code fires a few ms apart (last PostToolUse then Stop, or PermissionRequest then its Notification) often finish in reverse order. SM-24 then drops the newer event as stale: the card stays ASCENT and the `done` notification never fires. No gate catches this, because tests stamp `sentAt` themselves. | **Changed.** `sentAt = Math.floor(performance.timeOrigin)` (the hook process start time, which follows spawn order), plus the rationale in `attention.md` 3. Still required: none. Optional: add a hook test that spawns two hooks 5 ms apart and checks the order. |
| F3 | blocker | `api.md` 2 vs `tasks/T033.md` CARD-04 vs ARCHITECTURE 8 | Browser sessions are memory-only ("daemon restart = re-pair via `mc open`"). CARD-04 asserts "the page recovers on restart", and ARCHITECTURE 8 promises the page "retries WS every 2 s". After a restart the retry gets 401 and the page shows PAIRING REQUIRED, so CARD-04 cannot pass and the T033 builder hits a stop rule. The product problem is larger: every reboot, autostart or crash silently de-pairs the tab Woody keeps open on his second monitor. That is exactly when he needs it. | **Required (author).** Recommended: persist browser sessions in `stateDir/browser-sessions.json` (SHA-256 of cookie id and CSRF only, user-only permissions like `token`, 30-day idle expiry kept). `mc token rotate` clears them. Update api.md 2, `Auth`/`createAuth` (T015, add SEC-13) and CARD-04. If the author keeps memory-only, rewrite CARD-04 to assert the PAIRING REQUIRED banner and say in DESIGN.md what the user must do. |
| F4 | major | `claude-hooks.md` 1-2, `T051` IC-01, D-03, PRD A7 | The hook ran in shell form, pinned to `"shell": "powershell"` on Windows. That adds 0.3-1 s of PowerShell start-up to every event. SessionEnd's sync budget is 2 s, which the hook alone nearly uses up. A shell process also sits between the agent and the hook in the ancestry. Current Claude Code supports **exec form** (`command` + `args`, no shell, `.exe` required on Windows; verified in the docs). | **Changed.** One OS-independent hook object: `{"type":"command","command":"<NODE>","args":["<HOOK_JS>","claude-code"],"async":…,"timeout":…}`. Identification and uninstall match on `command` + `args`. The manifest records both. PRD A7 now requires `args` support, and the failure mode for older Claude Code is documented, with DR-06 detecting "no events". |
| F5 | major | `ingest.md` 3 `console`, `T020` | The whole Windows terminal story (conhost and the WT `ownerHwnd`) depends on `GetConsoleWindow()` in the hook. If Claude Code spawns hooks with `windowsHide`, libuv sets `CREATE_NO_WINDOW` and the hook has no console. `GetConsoleWindow()` then returns 0 and WT sessions fall to the ambiguous ancestry scan (`none`). Nothing in the plan verified this. | **Changed.** Fallback when 0: `FreeConsole`, `AttachConsole(agent.pid)`, `GetConsoleWindow`, `FreeConsole`. T020's checkpoint must record which path produced the handle on dev-pc. |
| F6 | major | `ingest.md` 3 agent rule, `T013` step 2, `T020` step 4 | For npm-installed Claude Code (`node.exe`), the agent rule read the command line. On Windows T013 does that with `powershell … Get-CimInstance`, which takes 0.5-1.5 s inside a hook with an 800 ms POST timeout and a 1500 ms self-kill. The envelope would often be lost. | **Changed.** With exec form (F4) the agent is the hook's direct parent: the rule is "nearest `claude`, else `ancestry[0]` if `node`/`bun`". No command lines are read. `commandLine` stays exported for doctor. |
| F7 | major | `ORCHESTRATION.md` 2 | `git switch -c main plan/specs` fails because `main` already exists (the seed commit `f454a14`). Setup dies at its first command. | **Changed** to `git switch main && git merge --ff-only plan/specs`. |
| F8 | major | `T001` step 1, expected output | `"packageManager": "pnpm@11.18.0"` is an invented version. dev-pc runs pnpm 11.2.2. pnpm fetches the pinned version and fails if it does not exist. The expected output hard-coded `pnpm 11.18.0`. | **Changed.** Pin the exact output of `pnpm --version` on the build machine. The expected output follows the pin. |
| F9 | major | `T001` step 9, `T033` | T033 owns `e2e/__screenshots__/**`, but `playwright.config.ts` (frozen after T001) sets no `snapshotPathTemplate`. Playwright would write `e2e/design.spec.ts-snapshots/…`, outside T033's files, and the DoD file-list check fails. | **Changed.** T001 sets `snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{platform}{ext}"`. |
| F10 | major | `T033` DS-08, `ORCHESTRATION.md` 7 | The screenshot baseline is created only on the builder's OS (Windows). On Linux (CI and WSL) DS-08 has no baseline and fails, so `gate:m2`..`gate` fail on Linux, which the project DoD requires. | **Changed.** The orchestrator generates and reviews `board-linux.png` in WSL after T033 merges (and darwin on a Mac). Note: the forge CI image and WSL may render fonts differently. If the 1% tolerance trips, generate the Linux baseline in the CI image instead. |
| F11 | major | `platform-adapter.md` 3, 5; `T003` FK-08; `T025` LV-02 | `FakeScript` had no way to mark a window dead or give a PID a start time. FK-08 asks for "not_found behaviour for deadWindow", and LV-02 asks for "alive with a different start time" using the fake, so both are guesswork. The generic conformance suite promised PA-05 "with an injected slow helper", which no generic adapter interface allows. | **Changed.** `FakeScript.deadHandles` and `startTimes` were added, with semantics in T003. PA-05 left the generic suite; each OS task tests it with an injected `Exec`. |
| F12 | major | `T025` GI-01, `readGit` | `git init -b mc-test` with no commit makes `rev-parse --abbrev-ref HEAD` exit 128, so GI-01 always gets the not-a-repo fallback and fails. A fresh repo is also a real case for Woody. | **Changed.** GI-01 makes an empty commit. `readGit` retries with `symbolic-ref --short HEAD` on exit 128. |
| F13 | major | `T050` step 3 | `mc stop` on Windows used `taskkill /pid` without `/F`. That sends WM_CLOSE, which a windowless detached Node process never receives, and Node has no SIGTERM on Windows. CLI-04 would fail on dev-pc. | **Changed.** Windows uses `taskkill /F`, waits, and removes `daemon.json`. The ≤500 ms snapshot-loss trade-off is stated. Optional for the author: a bearer `POST /api/shutdown` for a clean stop. |
| F14 | major | `macos.md` 3.4, 8 | "macOS has no foreground lock; `activate` from a background process is honoured" is false since macOS 14: background activation requests are often refused with a Dock bounce (Apple forum reports for Sonoma and macOS 26). | **Changed.** Verify-then-escalate: `activate`, poll frontmost, else System Events `frontmost` (Accessibility), else `partial/flashed`. Added manual row M-06 (the numbering gap). |
| F15 | major | `config.md` header, `T020` | config.md said T012 implements paths and that "CF-10 asserts the three implementations agree". T014 does, CF-10 tests `close()`, and nothing tested the hook's copy of `paths`. A wrong hook path silently spools forever. `ingest.md`/`windows.md`/`macos.md`/`linux.md` also cited T015 for process utilities, which is T013. | **Changed.** Added `HK-11 paths.ts resolves every case in …/paths.json` (T020, now 14/14; registry updated). config.md names CF-01/HK-11/VB-08. The stale task IDs are fixed. |
| F16 | major | D-05, PRD Q1 | The pairing code in a URL fragment conflicts with the workspace rule "Never: a token in a URL". The author's reasoning is sound: single use, 60 s, never sent to a server. But the rule is Woody's, and a reviewer cannot waive it. | **Required (Woody).** Decide before freeze. If rejected, the D-05 fallback (code entry box) changes T032, T050 CLI-05 and T033 `openPaired`. Pre-write that variant now so freeze is not blocked. |
| F17 | minor | `claude-hooks.md` 1, `attention.md` | Between a granted permission and the next PostToolUse there is no hooked event. A long approved tool (a 10-minute build) keeps the card on red GO/NO-GO, acknowledged if restored, though the agent is working. A denial is likewise invisible until the next event. | **Required (author judgement).** Either accept it and document it in DESIGN.md 4 (the acknowledged GO/NO-GO treatment), or hook `PermissionDenied` and decide whether `PreToolUse` after a grant re-fires (if it does not, say so). |
| F18 | minor | `ingest.md` 4 StopFailure | The hook input carries `error` (a type code such as `rate_limit`), optional `error_details` and `last_assistant_message`. "Whatever string field is named error or message" was guesswork. | **Changed.** `error = "<error>: <error_details>"` when details exist, else `error`. |
| F19 | minor | `attention.md` SM-04, SM-08, SM-18 | `SessionStart` `resume`/`fork` on a live session matched no row. PreToolUse/Subagent*/Compact from `idle` with `done` attention set the state to working but kept the `done` attention (and ack/renotify) alive. | **Changed.** SM-04 covers compact/resume/fork. SM-08/SM-18 clear `done`/`error` attention. |
| F20 | minor | `T010` | `project = basename(cwd)` in `@mc/core`, where lint bans `node:*`. A Haiku builder would reach for `node:path` and fail lint. | **Changed.** Split on `/` and `\`. |
| F21 | minor | PRD AC-09/AC-14/AC-20, README, D-03, D-06, TASKS T050 row, TEST-PLAN 6 | Small inconsistencies: AC-09 named only terminal-notifier (macos.md prefers alerter); AC-14 named one file for PS-01..05 (split across two); AC-20 cited a non-existent `mc doctor --budget`; README's gate line lacked `m5`; D-06 said `-open` where macos.md uses `-execute`; T050 owns `mc.ts` but TASKS did not list it; the M-row list skipped M-06. | **Changed** (all). |
| F22 | minor | `ORCHESTRATION.md` 7 | `pnpm gate` in WSL at m5 has no X server or session bus, so the `os` stage fails. | **Changed.** Same `xvfb-run -a dbus-run-session` wrapper as CI. |
| F23 | minor | `T001` step 4 | `vscode-bridge` imports bridge types from `@mc/contracts` (ARCHITECTURE 1) but did not declare the dependency. | **Changed.** Added, types only. |
| F24 | minor | `windows.md` 5, `T042` | (a) Each toast cold-starts Windows PowerShell 5.1 and loads WinRT, about 1-2 s against PA-07's 2 s timeout. On timeout `notify` returns null even if the toast showed, so `stats.notifications` and `withdraw` go wrong. (b) The protocol handler launches `node.exe` directly, so every toast click flashes a console window. | **Required (author judgement).** For (a), either a long-lived PowerShell host reading JSON lines on stdin (one spawn per daemon run) or a 4 s notify budget with PA-07 amended. For (b), keep it and make W-05 record the flash, or launch through a hidden `wscript` shim. Prove on W-05 that foreground rights still pass through it. |
| F25 | minor | `T015` SEC-10 | "Assert the icacls call" was impossible: `createAuth(paths, clock)` has no injectable runner. | **Changed.** On Windows the test reads `icacls <file>` and asserts there is no `Users`/`Everyone` entry. |
| F26 | minor | `internal.md` | Section numbering skips 5 (4 then 6). | Not changed: many task files cite "internal.md section 6", and renumbering would break them. The author may add an empty "5. (reserved)". |
| F27 | minor | `T002` step 3 | Whether `json-schema-to-typescript` 15 emits `$defs` of a schema with no root type (`api.schema.json`) is unverified. | **Required (author)**: one line in T002 telling the builder what to do if it does not: wrap the `$defs` in a root `anyOf` of `$ref`s inside `generate.mjs` only, never in the schema file. |

## Counts

3 blockers (F1-F3), 13 majors (F4-F16), 11 minors (F17-F27).

Changed in this round: F1, F2, F4-F15, F18-F23, F25 (22 findings).
Required from the author or Woody: F3, F16, F17, F24, F27; F26 optional.

## Things I checked and found sound

- Security: the Host check against rebinding, no CORS with OPTIONS answering 405, the
  custom CSRF header (the real defence, since other `localhost` ports are same-site
  and `SameSite=Strict` does not cover them), and WS Origin checks. `ingest` and
  `bridge` take bearer only, and no API accepts a handle or PID.
- The Windows foreground-lock handling (key trick, `AttachThreadInput`, flash
  fallback, `AllowSetForegroundWindow` from the activated `mc restore`). The degrade
  is honest.
- Wayland per-compositor backends with an explicit `none`. KWin scripting through
  `callDBus`.
- Wave ownership is disjoint (no two parallel tasks own a file). Stubs plus frozen
  signatures allow parallel daemon tasks. No acceptance command depends on a later
  task, except F3's CARD-04, which is fixed once F3 is resolved.
