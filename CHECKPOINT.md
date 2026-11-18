# Build checkpoint (newest on top)

## Dependency update for the audit (D-62) - 2026-11-17, branch `chore/deps-audit`

- Woody's versions: eslint 10, `@eslint/js` 10, jsdom 31, vitest 5, vite 7 at the root; overrides for `node-gyp` (usocket), `xml2js` (dbus-next) and `minimatch` 10 -> 11. The lockfile was resolved afresh because npm left the old entries under the overrides. `vitest.workspace.ts` -> `vitest.config.ts` (`test.projects`); ten `no-useless-assignment` fixes for ESLint 10. `npm audit` 32 (5 critical) -> 20 (0 critical); the rest is `picomatch` (no fix exists) and `@fastify/static` (not reachable: no `list`).
- Also fixed: `RELEASE-NOTES.md` must start with `# mission-control-desktop <version>` (RN-02, RN-04); the "Unreleased" section added in a182778 broke that, so it moved out (HANDOFF keeps the summary).
- Gate: run 1 `FAIL 21/23` (that release-notes line), run 2 `GATE m5 PASS 23/23`, ids 614/614 (`docs/validation/gate-windows-2026-11-17-deps.log`). No worker loss in either run.

## Wave 12 (Claude Code telemetry, AI Credits, the board on real data, D-61) - 2026-11-17, branch `feat/telemetry-live`

- T125 (orchestrator-built): `createClaudeFold` reads Claude Code transcripts and subagent transcripts into `Session.telemetry` (`sources: ["transcript"]`) and run traces (one run per prompt; model-call, tool, compaction spans; subagent spans under their Agent tool); `aiCredits = nanoAiu / 1e9` (Copilot CLI `NANO_AIU_PER_AIU`); the four board cards, the header credits pill and the Needs you line read real values only, the T sample preview is gone (T now hides or shows the row, which shows on its own once a session reports telemetry); terrain height is the token rate where a session reports one. Contracts: `sources` gains `transcript`, credit descriptions; lock hashes refreshed. Tests TL-10..15, TD-06..07, TC-01..05; TL-03, TA-02, TD-02, DS-06, DS-09 and the keyboard DS test updated for the new behaviour.
- Gate: runs 1 and 2 `GATE m5 FAIL` (run 1: CT-01 lock hashes not refreshed, fixed; plus `ERR_IPC_CHANNEL_CLOSED` in `integration`; run 2: the same worker loss in `cli`). Both stages pass alone (integration 2/2, cli 2/2). Run 3 `GATE m5 PASS 23/23`, ids 614/614 (`docs/validation/gate-windows-2026-11-17-t125.log`). The worker loss now hit two different stages: it is environmental, not the daemon-integration project.

## npm replaces pnpm (D-60) - 2026-11-17, branch `chore/npm`

- Root `package.json` lists the eight workspaces in build order; `pnpm-workspace.yaml` and `pnpm-lock.yaml` removed, `package-lock.json` added; `workspace:*` -> `*`. Gate runner puts `node_modules/.bin` on PATH instead of `pnpm exec`; gates.json, package.mjs (`npm --prefix <root> -w vscode-bridge`, hoisted versions), release.mjs, check-toolchain (npm >= 9: WSL Ubuntu ships npm 9.2), the dev-mode `mc install vscode`, the CI workflow and the tests follow. Living docs and the overview deck (rebuilt; slide 16 command size 11 so the longer commands fit) now say npm; historical records keep pnpm.
- Gate: run 1 stopped at toolchain (`npx` tried to download `node`), run 2 `FAIL 19/23` (Playwright 1.65.1 had no browser; package.mjs looked for unhoisted deps). Run 3 `GATE m5 PASS 23/23`, ids 601/601 (`docs/validation/gate-windows-2026-11-17-npm.log`). Re-tested on 887dca2 (npm floor lowered to 9): from a fresh clone with `npm ci`, Windows `GATE m5 PASS 23/23` 601/601 and Linux (WSL, Node 22, npm 9.2) `GATE m5 PASS 23/23` 600/600 (`docs/validation/gate-*-2026-11-17-npm-887dca2.log`); `npm run mc -- start|status|doctor|open --print|stop` with MC_HOME and MC_PORT=0, `npm run task:check T124` 10/10 after `npm run package`, the dev-mode bridge build and `vsce package` through `npm --prefix <clone> -w vscode-bridge` from another folder, and `docs/presentation/build.ps1` (PASS 5/5) all work. `npm run format` reports 233 files, the same as on master (not a gate stage). Not published to npmjs.

## Wave 11 (`mc uninstall --all`, D-59) - 2026-11-17

- Merged: T124 (`mc uninstall --all [--purge]`, UA-01..UA-09, SK-08), T124b (orchestrator: test daemons read `<MC_HOME>/copilot`, never the real `~/.copilot`; config.md).
- Orchestrator review fixes on T124 (the builder flagged the last two): `--all` stopped the daemon found from the machine's default dirs, not the dirs it removes (could stop the live daemon); the macOS purge guard refused `mission-control/state`; a failing `code --uninstall-extension` was reported removed and lost its manifest entry ("is not installed" now counts as removed).
- Gate: runs 1 and 2 `GATE m5 FAIL 21/23`: the vitest worker of `daemon-integration` died (`ERR_IPC_CHANNEL_CLOSED`) right after PS-04, so IT-01..06 and PS-05 were missing. Not reproduced in 8 isolated runs (the project alone x4, the stage through the gate runner x2, every stage up to it x1); no node.exe crash in the Application log. Run 3, after T124b, `GATE m5 PASS 23/23`, ids 601/601 (`docs/validation/gate-windows-2026-11-17-uninstall.log`; run 1 kept as `-run1`). Whether T124b fixed it is not proven: watch the next gates for the same signature.

## Wave 10 (telemetry views, D-58) - 2026-11-17

- Merged: T119 (helpers, routes, traces client), T120 (list columns), T121 (session page), T122 (run trace), T123 (wiring, key O), T120b (orchestrator: the list fits at 1440px).
- Failed attempts: T119 attempt 1 stopped on a CR (the ui vitest project collects only `.test.tsx`); rejected, the task files renamed the two `.ts` tests. No other failures.
- Orchestrator review fixes: T121 one Copy cwd for capability none, no traces fetch without telemetry; T123 Enter on a waterfall row does not restore (the builder flagged it).
- Gate: run 1 `GATE m5 FAIL 21/23` (`npm i -g` crashed natively, 0xC0000409, in package; SK ids missing from that suite); run 2 `GATE m5 PASS 23/23`, ids 591/591 (`docs/validation/gate-windows-2026-11-17-views.log`). Linux gate not run for waves 9-10.
- Live check on dev-pc against the running daemon: list, session page (MC-40, MC-41) and, with the traces route stubbed, the run trace. No OTel file exists yet (no Copilot session has started in a shell opened after `mc install shell`), so no real trace has been seen.

## Wave 9 (telemetry, D-56, D-57) - 2026-11-16

- Merged: T112 core telemetry fold, T115 `mc doctor copilot`, T116 per-shell OTel file, T113 daemon reads Copilot logs and OTel files, T114 Copilot account service over the SDK, T117 traces and spans per session, T118 three older tests follow D-56.
- Failed attempts: T117 attempt 1 (TT-04 did not check the route body); fixed in attempt 2 by the same Haiku builder. T112's builder could not take the codegen fix (permission layer denied the checkout); the merge brought it in.
- CRs and decisions: D-56 (telemetry data path, SDK runtime dependency, contracts), D-56 item 8 (codegen `maxItems: -1`), D-57 (traces; T114 CR accepted: `deps.ts` copilot stub).
- Gate: first run `GATE m5 FAIL 20/23` (IX-03, LN-10, PK-03 pinned pre-D-56 values; T118). After T118 `GATE m5 PASS 23/23` on Windows, ids 565/565 (`docs/validation/gate-windows-2026-11-16-telemetry.log`). Linux gate not run for wave 9.
- Real-runtime check: `mc doctor copilot` on dev-pc PASS 8/9 (D6 WARN: runtime lists 14 sessions, 15 folders).
- Open: UI for the telemetry (waits for Woody's references and a design round); live daemon not yet rebuilt; `mc install shell`, VS Code OTel settings and `mc install copilot` not yet run; follow-ups: D8 tolerate a torn last line, DC-05 assertion, OTel cleanup test, skip save on token-rate-only change, AI Credits from model prices.

## Packaging done (2026-11-15) - `GATE m5 PASS 23/23` Windows 517/517 and Linux 516/516; fresh-machine FM-01..08 PASS

- **Playwright validation found three more product bugs, each fixed through the normal task
  loop (builder, validator, merge):**
  - **T096:** the bundled `mc.js` had no shebang, so npm's `mc.cmd` ran it through the `.js`
    association (WSH: silent, exit 0) and `mc` did nothing on a real install. SK now runs
    `mc` through the installed shims. PK-10, SK-07.
  - **T097 and T098:** PowerShell passes an unquoted `a,b` to npm's `mc.ps1` as the single
    argument `"a b"`, so `mc init --agents` exited 2. It now splits on commas and
    whitespace. IN-13, IN-14.
- **Earlier "all PASS" sandbox run was wrong:** its steps only checked exit codes, and the
  PS 5.1 transcript dropped the output. The harness
  (`docs/validation/fresh-machine-2026-11-15/`) now captures each step's output and checks
  values.
- **FM-08:** Windows Sandbox runs everything elevated (an admin account with UAC off;
  `runas /trustlevel` does not de-elevate without UAC), and mission-control by design does
  not focus elevated windows. FM-08 was proven on dev-pc with the same tarball in a temp
  prefix, temp MC_HOME and port 0: the target was minimized, then RESTORE gave FOCUSED with
  the foreground window equal to the target.
- **T091 docs:** the user guide leads with `npm i -g`, `mc init`, `mc launch`, plus upgrade,
  reference, from-a-clone and the full uninstall. PRD 5 updated. HANDOFF blocker 5 DONE.
- **Open, for Woody:**
  - the forge release (`pnpm release`, tag `v1.0.0`, upload the tarball, `.vsix` and notes);
  - tagging `m5` and pushing, which waits on blocker 4, the W- checklist;
  - follow-ups: Codex uninstall scope; the `mc init` "no terminal" wording after three bad
    answers; T090's bootstrap should adopt the validation harness's output capture.

## Waves 8g-8h / packaging: T088, T093, T089, T094, T090 merged (2026-11-15)

- **T088** (`scripts/release.mjs`, 1.0.0 `RELEASE-NOTES.md`, consistent with the README; the
  Unverified section lists the macOS rows and the Sandbox-only proof): `TASK T088 PASS 5/5`.
- **T089** (package-install smoke, gate stage `package`): attempt 1 stopped with a CR. A
  real product bug: `npm i -g` hung for more than 4 minutes, because dbus-next's optional
  `usocket` ran `node-gyp rebuild`. **D-47 and T093** bundle dbus-next and keep
  `usocket`/`x11` external and never dependencies. T093's x11 CR was approved and D-47
  amended. T089 was rebased onto T093 by the orchestrator. Attempt 2 is `TASK T089 PASS 6/6`,
  with `npm i -g` at 25 s (warm cache, 96 packages).
- **T094** (leak fix): PC-13 and IN-10..12 deleted the temp MC_HOME before `mc stop`, so
  every run leaked a daemon. 18 leaked test daemons (task, validate and check worktrees)
  were killed by the orchestrator; pid 21788 was untouched. Now `TASK T094 PASS 2/2`, and
  LK-01/LK-02 prove the pids are dead. The orchestrator's merge script also had a broken
  leak check (an invalid PowerShell regex that always printed 0). It now uses a `-like`
  counter verified against pid 21788.
- **T090** (`.wsb` generator and `bootstrap.ps1`, SB-01..10): `TASK T090 PASS 10/10`.
  Sandbox was never started, and bootstrap.ps1 was only parse-checked. The Node MSI is not
  downloaded. The hook-event quoting is unproven until FM-07/FM-08.
- **Open:**
  - the Windows `pnpm gate` (its os stage moves windows and raises toasts, so it needs
    Woody's OK);
  - the Linux gate with the `package` stage (WSL);
  - FM-01..FM-08 in Windows Sandbox (Woody), then T091.
  - Follow-up: Codex uninstall search scope (wave 8d entry).

## Wave 8f / packaging: T087 and T092 merged (2026-11-15) - integration e651511

- **T087** (`scripts/package.mjs` builds `release/mission-control-desktop-1.0.0.tgz`, about
  551 KB, 61 entries matching PACKAGING.md 2, plus the `.vsix`; `release/**` ignored by lint
  and prettier): `TASK T087 PASS 8/8`, attempt 2. Attempt 1 stopped with two CRs, both ruled
  by the orchestrator: the PK-05 esbuild define labels, and the README wording after D-46.
  T087.md now has an Amendments section.
- **T092** (`mc init` agent prompt with Copilot pre-selected, `--agents`, support installers;
  `mc launch`): `TASK T092 PASS 12/12`, attempt 1. Validator PASS. Known wording wart: three
  invalid menu answers print the same "(no terminal to ask on)" line as the no-TTY case.
- **Post-merge checks** in `check-integration` (T087 with `pnpm package` first), all green.

## Wave 8e / packaging: T085 merged (2026-11-15)

- **T085** (cli paths via `layout()`, koffi resolution in package mode, `mc --version`,
  doctor `hook-paths`, `mc start` launcher self-heal): `TASK T085 PASS 13/13`, attempt 1.
  Validator PASS. T050, T083 and T084 still pass.
- **Note:** PC-13 needs `packages/daemon/dist/bin.js`. In the gate this holds by stage order,
  because the m1 integration stage pre-builds the daemon.

## Wave 8d / packaging: T084 and T086 merged (2026-11-15) - integration 84a9173

- **T084** (repair in place for claude-code, copilot and codex; launchers written; MC_HOME
  skips the automatic uri step): `TASK T084 PASS 14/14`, attempt 1. Validator PASS. This
  closes the T083 transient.
- **T086** (`mc install vscode` installs the shipped `.vsix` in package mode, filter renamed,
  `.vscodeignore`): `TASK T086 PASS 8/8`, attempt 1. Validator PASS, and IX-08 still passes.
- **Follow-up (not blocking):** Codex uninstall (`codex.ts:202`) searches the whole file for
  the first `notify =`, while install searches only the top level. It never changes a
  non-mc line (the identification gate at :204), but it can miss the mc line when a user's
  top-level `notify` comes before it. The fix is to scope the search to lines before
  `firstTableIndex`.
- **Post-merge checks** in `check-integration`, all green.

## Wave 8c / packaging: T082 and T083 merged (2026-11-15) - integration 142077f

- **Also merged before the wave:** `plan/init` (D-46, T092: `mc init` agent prompt with
  Copilot pre-selected, `mc launch`) as 4108ecf.
- **T082** (platform and daemon read `layout()`): `TASK T082 PASS 9/9`, attempt 2.
  Attempt 1 failed validator check 3, because the task's step 7 itself prescribed
  source-text asserts. Attempt 2 (Haiku) rewrote RW-02, RW-06 and RW-08 as produced-value
  tests, and RW-07 is accepted as a static guard. T082.md now has an Amendments section.
  The 8 skipped tests in path-form runs are the existing `platform-os` files, unchanged.
- **T083** (launchers, installer paths, test amendments incl. CP-10): `TASK T083 PASS
  13/13`, attempt 1. Validator PASS. T051 16/16 and T070 14/14 still pass.
- **Post-merge checks** in `check-integration`, all green. The integration worktree was not
  rebuilt (daemon pid 21788).
- **Transient until T084:** the claude, copilot and codex installers record launcher paths
  that nothing writes yet. T084 must merge next.

## Wave 8b / packaging: T081 merged (2026-11-15) - `TASK T081 PASS 12/12` on integration 92ceeca

- **Merged:** T081 (`packages/platform/src/layout.ts`, `@mc/platform/layout`, clone and
  package modes). Haiku builder, attempt 1. Haiku validator PASS. LY-12 checks a built file
  exists rather than a module value; accepted, because it guards the `./layout` export
  target.
- **Post-merge checks** in `check-integration`: install, typecheck, lint, build,
  `task:check T081` and T080, all green. The integration worktree was not rebuilt (daemon
  pid 21788).
- **In flight:** `plan/init`, Woody's `mc init` (agent multi-select, Copilot pre-selected)
  and `mc launch` (D-46, T092), being written for review.

## Wave 8a / packaging: T080 merged (2026-11-15) - `TASK T080 PASS 16/16` on integration f4a6ce1

- **Plan merged:** `plan/packaging` (942ceb7) into integration as a78ce80: D-39..D-45,
  `docs/PACKAGING.md`, tasks T080-T091, 114 m5 test IDs.
- **Merged:** T080 (manifests at 1.0.0, `scripts/version.mjs`, platform `./layout` export and
  macOS script copy, bridge renamed `vscode-bridge` with `dist/extension.cjs` and a `package`
  script, root esbuild, Vitest `@mc/platform/layout` alias and `packaging` project). Haiku
  builder, attempt 1. Haiku validator PASS.
- **Post-merge checks** ran in a separate detached worktree (`check-integration`): install,
  typecheck, lint, `pnpm -r build`, `task:check T080`, all green. The integration worktree
  was not rebuilt, because the running daemon (pid 21788) serves from its `dist/` during the
  W- checklist.
- **Known transient break:** the real `mc install vscode` still filters `@mc/vscode-bridge`
  until T086. Tests use an injected runner and stay green.
- **Lock:** `pnpm-lock.yaml` gained root esbuild ^0.25.12 (from T080's `pnpm add -Dw`).
- **No gate run:** m5 is not complete until wave 8 lands.

## Codex and Copilot, proven with real agents (2026-11-12) - `pnpm gate` GATE m5 PASS 22/22 (384/384)

- **New tasks:** T070 Copilot CLI adapter (D-36, CP-01..14), T072 Codex fixes (D-37: notify
  chaining keeps an existing `notify`; Codex's title-thread turn dropped; pair-code takes an
  empty body), T075 Copilot fixes (uninstall cleans its backups and the hooks dir it
  created; Copilot end reasons mapped; D-38 SessionEnd sets `process.alive = false`).
- **Real runs** (Woody approved real configs with restore), evidence in
  `docs/validation/agents/`: `codex.md` + `codex-board.png` + `codex-card-snapshot.yml`
  (real `mc install codex` with chaining, one card per turn, pair-code without content type,
  uninstall restores the original line; `~/.codex/config.toml` SHA-256 back to
  AAB7EA81...32C0) and `copilot.md` + `copilot-board.png` + `copilot-card-snapshot.yml`
  (stdin JSON confirmed, snake_case payloads with `hook_event_name`, `copilot.exe` is the
  hook's parent; `~/.copilot/hooks` absent before and after). Orchestrator re-checked hashes,
  directories and processes after each run.
- **Not yet proven:** that the chained Codex computer-use program actually starts (no error
  logged, but a 100 ms watcher never saw it); Copilot permission prompts and notification
  types (the test turn used no tools).
- **Seen in the runs:** the page logs eight 401s in the console before pairing; `codex exec`
  and `copilot -p` give an immediately ended card (interactive sessions stay live).

## Waves 4-6 / M1-M5 on Windows (2026-11-12) - `pnpm gate` GATE m5 PASS 22/22 (369/369 ids, os=windows)

- **Merged:** T027 (m1), T050-T053, T033, T034 (new fix task), T054, T045, T046, T060.
  All 36 planned tasks plus T034 are on `integration`. Tags: m1, m2, m3, m4 (m3 = Windows
  only). `main` fast-forwarded. Log: `docs/validation/gate-windows-2026-11-12.log`.
- **Not tagged m5:** ORCHESTRATION 9 also needs the Linux gate, the W- checklist and the
  manual steps of ORCHESTRATION 7 with Woody (see Open below).
- **Failed attempts and fixes:**
  - T027 stopped twice: reading-list gap (D-28), then the m1 audit could not see T013's
    PR-* ids (D-29 adds an m1 `process` stage). Validator's `powershell` 5.1 could not parse
    `&&`; all acceptance commands are run with `pwsh` 7 since.
  - T050 CLI-08 title said 401, contract says 403 (D-31).
  - T051 attempt 2 after a Sonnet safety review found four real installer defects (TOML
    splice inside a multi-line array, shell uninstall stuck on a bad config.json, VS Code
    manifest lost on partial failure, uri manifest written before success).
  - T054 reading-list gap (D-32).
  - T033 found four product defects (fixed by new task T034, D-34) and two DESIGN.md
    contradictions (D-34 project case, D-35 ended-card opacity). Round 2 merged red: test
    data came from the worktree's own folder and branch; round 3 uses a temp fixture repo
    and scans a11y with reduced motion (blink phase made AX-01 timing-dependent).
  - Merge script now builds before `task:check` (T033 needs the built UI).
- **Decisions:** D-28 .. D-35 (see DECISIONS.md), D-33 builds T045/T046 on Windows.
- **Unverified OS rows:** macOS MO-01..MO-06 (no Mac). Linux LO-01..LO-07 verified in WSL
  2026-11-14.
- **Open, for Woody:**
  - ~~WSL packages, then the Linux gate~~ DONE 2026-11-14: installed via `wsl -u root`;
    `GATE m5 PASS 22/22`, ids 383/383 (os=linux) in `docs/validation/gate-linux-2026-11-14.log`;
    `board-linux.png` committed. The first run found only test bugs (WSLg WAYLAND_DISPLAY leak,
    multicall coreutils, dbus-next API, tmux window index, sub-ms hook start races); fixed in
    0eacde3 and 9de35de. WSL clone at `~/wt/mc-gate`; Ubuntu's corepack cannot load pnpm 11, so
    `~/bin/pnpm` runs the cached pnpm.cjs with node.
  - After T042: `pnpm mc install uri-handler` on dev-pc, `POST /api/notify/test`, click
    the toast, confirm `mc restore` runs.
  - ~~After T052: confirm the Claude panel command ids~~ DONE 2026-11-14: Claude Code
    2.1.323's manifest contributes `claude-vscode.focus` ("Focus input") and
    `claude-vscode.sidebar.open` ("Open in Side Bar"); `claude-code.focus` is absent and
    stays as the last fallback. Order unchanged (vscode-bridge.md 4).
  - At m3: the W- checklist (docs/platforms/windows.md 9) into docs/validation/.
  - Design: blink off-phase contrast (state labels drop to ~1.0-1.3:1 in the off half-cycle;
    AX-01 scans the reduced-motion steady state). Decide whether the blink should dim to a
    contrast-safe colour.
  - `packages/vscode-bridge/package.json` name `@mc/vscode-bridge` is not a valid VS Code
    extension name; packaging a .vsix needs `vscode-bridge` (D-30).
- **Follow-ups (not blocking):** `pnpm -w run typecheck` never checks `test/` files (every
  package tsconfig includes only `src`); bash/zsh snippets replace an existing EXIT trap and
  pwsh's Enter binding (documented in USER-GUIDE); tmux socket not persisted across daemon
  restarts and `KITTY_LISTEN_ON` missing from linux.md's display-env list (T045); no shared
  raw SessionEnd hook fixture (T054); a partial Windows uri-handler failure can leave an
  HKCU key with no manifest entry (T051); CLI-06 does not assert the notification source.

## Waves 1-3 (2026-11-12) - wave 1 complete; wave 2 except T045/T046; T026; T053 pulled forward

- **Merged:** T010-T016, T030-T032 (wave 1); T020-T025, T040-T044 (wave 2); T026 (wave 3);
  T053 (wave 5, depends only on T020). All Haiku builders, Haiku validators except T026
  (Sonnet validator: heavy task, security surface).
- **Scheduling deviation:** wave-2 and later tasks were started as soon as their own
  "Depends" were merged rather than waiting for the whole previous wave; ownership is
  disjoint, so this only changes order. At most 6 builders ran at once.
- **Failed attempts:**
  - T032 stopped on a reading-list gap (D-24); T020 stopped twice, on a missing root
    re-export (D-25) and a missing koffi dependency (D-26). All re-ran green on Haiku.
  - T026 stopped on the WebSocket seq conflict (D-27); attempt 2 then failed validation:
    API-12 depended on the repo being on a named branch (fails on detached HEAD), and
    ingest lacked api.md 4's 200/s rate limit. Fixed on the same branch; re-validated detached.
  - T053 merged green per its validator (run from Git Bash) but went red on integration
    from PowerShell: PATH resolved `bash` to the WSL launcher. Reverted, fixed (resolve Git
    Bash explicitly), revert reverted, re-merged green.
- **CRs and decisions:** D-24 (T032 reads session.schema.json), D-25 (`@mc/platform` root
  re-exports process utilities), D-26 (`@mc/hook` depends on koffi), D-27 (WS hub owns the
  wire seq).
- **Interpretations to review:** T010 applies SM-24/SM-25 as guards before the row table
  (attention.md 4 says first match wins, but 4's out-of-order text needs SM-24 first).
  T015 adds optional `windowMs` to route rate limits. T031 disables RESTORE on a lost
  card with capability none (DESIGN.md 4 over the task step). T053's bash/zsh snippets
  overwrite an existing EXIT trap and pwsh's Enter binding (spec silent; follow-up worth
  doing). T053 snippets read `__MC_STATE_DIR__`, which T051 must substitute.
- **Unverified OS rows:** macOS MO-01..MO-06 (T043, T044; no Mac). Linux T045/T046 not
  started: WSL Ubuntu-26.04 lacks node, Xvfb, openbox, wmctrl, xdotool, xterm and sudo
  needs a password - waiting on Woody.
- **Flaky once:** T042 WO-06 missing on the builder's first run; 3/3 green for the validator
  and green on integration.

## Wave 0a-0d / M0 (2026-11-12) - `GATE m0 PASS 8/8`, tagged `m0`

- **Merged:** T001 (scaffold), T004 (gate runner), T002 (contracts), T003 (platform types, fake).
- **Failed attempts:**
  - T001 attempt 1 (Haiku) stopped at the read stage with three CRs; answered in D-22.
    Attempt 2 ran on Sonnet (heavy task, the failure was not a typo-level slip, per
    ORCHESTRATION 5). The first attempt-2 builder was paused mid-write by Woody; a second
    Sonnet builder resumed on its uncommitted files and passed.
  - T003 attempt 1 (Haiku) stopped on a CR (FakeCall method union vs "every method appends
    a FakeCall"; no NullPlatform resolveTarget reason). Accepted as D-23; re-run on Haiku passed.
- **CRs and decisions:** D-22 (T001 reading list, placeholders, stubs, lint rule), D-23
  (`FakeCall.method` covers every adapter method; NullPlatform reason `no_window_found`).
- **Builder notes worth keeping:** pnpm 11.2.2 exits 1 on ignored build scripts, so
  `pnpm-workspace.yaml` has an `allowBuilds` map (T001). `scripts/test-ids.json` was
  generated from TEST-PLAN 4 (382 IDs, T004). T004's Playwright parser is unexercised until
  e2e tests exist. T002's `fixtures/ingest/raw/cc-*.json` were written from ingest.md 4,
  not from the live hooks docs. T003 picked `os: "linux"` for NullPlatform/FakePlatform
  defaults and "most recent onClick" for `fake.click`.
- **Unverified OS rows:** none yet (M0 is OS-independent).
