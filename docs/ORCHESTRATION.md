# Orchestration: running the Haiku builders

This is the orchestrator's manual. Builders never read it; they read `AGENTS.md` and
their task file. The workspace rule behind it is
`C:\Users\you\Workspace\.claude\skills\serialize-writes\SKILL.md`: fan out reading,
serialize writing; interfaces frozen and under contract tests before the fan-out
(that is M0); one writer per file; the orchestrator is the only writer of shared state
and the only one who merges.

## 1. Roles

| Role | Model | Writes | Never |
|---|---|---|---|
| Orchestrator (the main session) | Opus or Sonnet | `integration`, `master`, tags, `CHECKPOINT.md`, `package-lock.json` resolutions, `docs/**` amendments with a D-nn | writes product code except in escalation step 4 (section 5) |
| Builder (one per task) | Haiku | only the files in its task's "Files" list, on `task/T###-<slug>` | pushes, merges, rebases, launches agents, edits frozen files |
| Validator (one per finished task) | Haiku | nothing (read-only; replies PASS/FAIL) | fixes anything |

## 2. Setup (once, after the plan freezes)

```powershell
hostname                                   # must be dev-pc
cd C:\Users\you\Workspace\harness-tools\mission-control
git switch main                            # main already exists (seed commit f454a14)
git merge --ff-only plan/specs             # main starts at the frozen plan
git switch -c integration main
git switch plan/specs
```

Worktrees live outside the repo so tools never index them:
`C:\Users\you\Workspace\.worktrees\mission-control\<branch with / replaced by ->`.

```powershell
git worktree add ..\..\.worktrees\mission-control\task-T010-attention -b task/T010-attention integration
# after merge:
git worktree remove ..\..\.worktrees\mission-control\task-T010-attention
git branch -d task/T010-attention
```

Linux tasks (T045, T046) build in WSL2 Ubuntu on dev-pc, in a clone, not a worktree
across `/mnt/c` (slow, and file modes break):

```bash
git clone /mnt/c/Users/you/Workspace/harness-tools/mission-control ~/wt/mc-T045
cd ~/wt/mc-T045 && git switch -c task/T045-linux-focus origin/integration
sudo apt-get install -y wmctrl x11-utils xdotool xterm openbox tmux xvfb dbus-x11
```

The orchestrator fetches the result back:
`git fetch \\wsl$\Ubuntu\home\you\wt\mc-T045 task/T045-linux-focus:task/T045-linux-focus`.

macOS tasks (T043, T044) run on a Mac if one exists (PRD Q4); otherwise on dev-pc,
where `task:check` checks only their `any` IDs, and the macOS rows go into
`CHECKPOINT.md` as unverified.

## 3. The builder prompt (verbatim; fill the angle brackets)

```
You are the builder for task <T###> of mission-control.
Work only in <worktree path>, on branch task/<T###>-<slug>. Run `hostname` first.
Read, in this order and nothing else: AGENTS.md, docs/tasks/<T###>.md, and every file the
task lists under "Codes against".
Do exactly the steps. Create or modify only the files under "Files".
Commit on your branch as you go, plain messages, no trailers. Do not push, merge, rebase,
or launch other agents.
Done means: the acceptance command prints the expected last line and exits 0;
`npm run typecheck` and `npm run lint` exit 0; docs/checkpoints/<T###>.md is
written and committed.
If a stop rule in AGENTS.md applies, write the checkpoint with `CR:` lines and stop.
Reply with: the last 5 lines of the acceptance command output, the output of
`git diff --name-only integration...HEAD`, and any CR lines.
```

The validator prompt:

```
You are the validator for task <T###> of mission-control. You change nothing.
In a fresh worktree of branch task/<T###>-<slug>: `git clean -xfd`, `npm install
--frozen-lockfile`, then run the acceptance command from docs/tasks/<T###>.md exactly.
Check: (1) it prints the expected last line and exits 0; (2) `git diff --name-only
integration...HEAD` lists only files from the task's "Files" plus its checkpoint;
(3) every test whose title starts with one of the task's IDs contains at least one
expect() on a value produced by the code under test (not a literal), and none is
skipped; (4) `npm run typecheck` and `npm run lint` exit 0.
Reply with PASS, or FAIL and the failing check with its output (last 30 lines).
```

## 4. Wave procedure

For each wave in `docs/TASKS.md` order:

1. Create one worktree and branch per task from the current `integration`.
2. Launch the builders of the wave **in one message** (parallel). On dev-pc run at
   most 6 builders at once (Vitest and Playwright are CPU-heavy); wave 1 (10 tasks) and
   wave 2 (13 tasks) go in batches: wave 1 = {T010-T015} then {T016, T030-T032};
   wave 2 = {T020-T025} then {T040-T042 on Windows, T045-T046 in WSL, T043-T044}.
3. When a builder replies, launch its validator.
4. Merge validated branches into `integration` in ascending task ID order:
   `git switch integration && git merge --no-ff task/<T###>-<slug> -m "Merge <T###>: <title>"`.
   If the branch is behind, rebase it first (`git rebase integration` in its worktree,
   done by the orchestrator). Conflicts: in `package-lock.json`, take integration's and
   run `npm install`, commit; anywhere else, the branch goes back to its builder with
   the conflict (it should not happen: ownership is disjoint).
5. After each merge: `npm install && npm run typecheck && npm run lint &&
   npm run task:check <T###>` on `integration`. Red -> `git revert -m 1 <merge>`
   immediately (never fix forward on integration) and treat it as a failed attempt.
6. At the end of the wave: run `npm run gate:<mN>` for the highest milestone whose tasks
   are all merged; green -> tag `mN` on integration and fast-forward `master`
   (`git switch master && git merge --ff-only integration && git tag mN`).
7. Append a wave entry to `CHECKPOINT.md` (newest on top): merged tasks, failed attempts
   and why, CRs and decisions, unverified OS rows.

## 5. When a task fails its gate

| Attempt | Who | What changes |
|---|---|---|
| 1 | Haiku builder | the task as written |
| 2 | a new Haiku builder on the same branch | the prompt adds: the previous checkpoint, the failing command output (last 60 lines), the validator's reply |
| 3 | Sonnet builder on the same branch | same as 2, plus "you may restructure the code inside your files" |
| 4 | the orchestrator | reads the diff and the failure; either fixes it directly on the branch, or decides the task is wrong: splits it, rewrites the task file, or amends a contract with a D-nn, then restarts at attempt 1 |

Tasks marked heavy (T001, T004, T026, T027, T041, T045) may start at attempt 3's model
if attempt 1 fails for a reason other than a typo-level slip; record the choice.

A task in a later wave that depends on a failing task waits; independent tasks of the
same wave keep going.

## 6. Change requests (CR)

A builder's `CR:` line means a frozen file is wrong or missing something. The
orchestrator, before relaunching anyone:

1. Decides: **accept** (edit the contract or task file, add `D-nn: Amends <file>` to
   `docs/DECISIONS.md`, commit on `integration`, rebase every open branch whose task lists
   that file under "Codes against", and tell their builders with a message naming the
   change) or **reject** (answer in the builder's next prompt with the clarification).
2. Never lets a builder edit a frozen file, even "just one line".

## 7. Manual steps the orchestrator owns

| When | Step |
|---|---|
| after T033 merges | look at `e2e/__screenshots__/board-win32.png` against DESIGN.md before accepting the baseline; then, in the WSL clone, `xvfb-run -a npx playwright test e2e/design.spec.ts -g DS-08 --update-snapshots`, review and commit `board-linux.png` on `integration` (and `board-darwin.png` on a Mac, if any). Without a baseline for an OS, DS-08 fails on that OS and so does its gate |
| after T042 merges | with Woody: `npm run mc -- install uri-handler` on dev-pc, trigger `POST /api/notify/test`, confirm a toast appears and clicking it runs `mc restore` |
| after T052 merges | with Woody: the Claude panel command ids (vscode-bridge.md 4) |
| at `m3` | Woody runs the W- checklist on dev-pc (`docs/platforms/windows.md` 9), the L- checklist where a Linux desktop exists, the M- checklist if a Mac exists; results in `docs/validation/` |
| at `m5` | `npm run gate` on dev-pc from an interactive session; in WSL/Linux `env -u WAYLAND_DISPLAY xvfb-run -a dbus-run-session -- bash -c 'openbox & sleep 1; npm run gate'` (the `os` stage needs an X server and a session bus; WSLg sets `WAYLAND_DISPLAY`, which would route focus to the Wayland backend instead of the Xvfb display); logs to `docs/validation/gate-<os>-<date>.log` |

## 8. Escalate to Woody (stop and ask)

- Anything on the workspace "Ask first" list: starting a VM, touching `archive/`,
  anything that leaves the tailnet (the CI workflow only runs on the forge).
- Writing to the real Claude Code settings, the real registry (outside tests' own test
  AUMID), real shell profiles, or installing the VS Code extension into his VS Code.
- A CR that changes a PRD acceptance criterion or a platform claim.
- A platform task failing attempt 4.
- PRD open questions Q1-Q6 when a task reaches them.

## 9. Definition of done for the project

`npm run gate` exits 0 with `GATE m5 PASS n/n` on Windows and Linux, the logs are committed
under `docs/validation/`, the W- checklist is recorded, the macOS status is recorded as
PASS or unverified, and `master` is tagged `m5`.
