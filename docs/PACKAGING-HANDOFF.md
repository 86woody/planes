# Packaging: handoff to the spec-writing agent (2026-11-15)

You are writing the **plan** for packaging mission-control: a decision record, a spec and
task files. You write no product code. Builders (Haiku) will run your task files later,
so write them the way T001-T075 are written.

## Why this exists

v1 runs from a clone (`pnpm install && pnpm build && pnpm mc install`). PRD section 5
listed "a packaged installer or single binary" as a non-goal and D-01 deferred it. On
2026-11-15 Woody promoted packaging to an **m5 blocker** (`HANDOFF.md`, blocker 5): `m5`
is not tagged until the W- checklist is recorded **and** packaging is done.

## Read first, in this order

1. `AGENTS.md` and `CLAUDE.md` (repo working rules; frozen files; no trailers)
2. `HANDOFF.md` and `CHECKPOINT.md` (current state)
3. `docs/PRD.md` sections 4-5 and `docs/DECISIONS.md` D-01, D-02, D-30
4. `docs/TASKS.md` (format, waves, owns), `docs/tasks/T001.md`, `T051.md`, `T060.md` (shape to copy)
5. `docs/ORCHESTRATION.md` and `docs/TEST-PLAN.md` sections 2 and 6 (gates, test ID registry, `task:check`)
6. `docs/USER-GUIDE.md` (the install steps that packaging replaces)
7. `docs/contracts/config.md` (where files live; `MC_HOME`)

## Known facts

- Stack lock: Node >= 22, pnpm 11, TS strict ESM, Fastify 5, Ajv 8, React 19 + Vite UI,
  `koffi` (Win32 FFI), `dbus-next` (Linux). A new runtime dependency is a contract change.
- `@mc/cli` already has `"bin": {"mc": "./dist/mc.js"}`. Root and every package are
  `"private": true`; workspace packages use `workspace:*` deps.
- `mc-hook` runs per Claude Code event and pays Node start-up (~60-120 ms). It is async,
  so this is accepted (D-03). Any packaging choice must not make it slower or break its
  exit-0-within-1500 ms rule (AC-11).
- `packages/vscode-bridge` is named `@mc/vscode-bridge`, which is not a valid VS Code
  extension name. The extension id is `woody.vscode-bridge` (D-30). Rename to
  `vscode-bridge` before a `.vsix`.
- `koffi` ships native `.node` prebuilds, and the toast host / `restore.vbs` shim are
  Windows files: any bundle or SEA must carry them. Signing and bundling for toast
  clicks was noted as out of scope in D-02; revisit.
- Installers write outside the repo: Claude Code hooks into `~/.claude/settings.json`,
  shell rc blocks, HKCU URI handler, Copilot and Codex config. Packaging must not change
  what `mc install` / `mc uninstall` add or remove, only where the `mc` and `mc-hook`
  executables live.
- OS matrix: Windows verified on dev-pc; Linux verified in WSL; macOS has no
  machine (MO-01..06 unverified), so macOS packaging can be specified but not proven.

## Decisions you must make (write them as D-39 onward, in DECISIONS.md style)

1. **Distribution form.** Options: published npm package (`npm i -g`), Node SEA single
   executable per OS, or both. Recommend one with the cost accepted. Cover `koffi` and
   `dbus-next` native code, the built UI assets, and the daemon + hook entry points.
2. **Hook path stability.** Hooks in `~/.claude/settings.json` point at `mc-hook`. Decide
   how an upgrade or a moved install keeps them valid (and how `mc doctor` reports a stale path).
3. **VS Code bridge.** Rename, build a `.vsix` (tooling choice: `vsce` is a dev
   dependency), and whether to publish to a marketplace or ship the file only.
4. **Install script per OS** (`install.ps1`, `install.sh`) versus plain `npm i -g`.
5. **Versioning and release notes**: where the version lives, how a release is cut,
   what the release notes must say (macOS unverified rows stay stated, PRD section 8).
6. **Scope line.** What is v1-packaging and what is explicitly deferred (auto-update,
   signing and notarization, Homebrew/winget, a service/launchd unit).

If a decision needs Woody, list it under "Needs Woody" at the top of your output with a
recommendation and stop short of building on it.

## Deliverables

- `docs/DECISIONS.md`: new D-entries (next free number; check the tail, D-37 and D-38 are
  out of order in the file).
- `docs/PACKAGING.md`: the spec (artifact layout per OS, build steps, install and
  uninstall flow, upgrade behaviour, what is verified where).
- Task files `docs/tasks/T080.md` onward in the T060 format (goal, codes against, files,
  do not touch, steps, acceptance command, expected output), one owner per file, plus a
  new "M5 packaging" row and wave in `docs/TASKS.md`.
- Test IDs for each acceptance check in the registry (`docs/TEST-PLAN.md`), so the
  test-ID audit stays at 100%.
- A fresh-machine install proof as the final task: install the package on a clean
  machine or VM with no clone, then run `mc install claude-code`, `mc start`, `mc open`
  and one RESTORE. State which OS it runs on and how.
- Edits to `HANDOFF.md` blocker 5 to point at your task ids; update PRD section 5 and
  `docs/USER-GUIDE.md` install steps only as task steps, not directly.

## Rules

- Docs and plans only. Branch `plan/packaging` from `integration` in a worktree; never
  commit to `integration` or `main`. No `Co-Authored-By` trailers. No push.
- `hostname` before anything destructive. Never read `.env` or credential stores.
- Do not install anything into the real `~/.claude/settings.json` (the W- checks use it).
- Do not touch the running daemon (pid 21788, port 47800) or the `MC-W01` window.
- No subagents launching subagents. One reviewer pass at most, Sonnet.

## Definition of done

`pnpm task:check` still passes for every existing task, the test-ID audit reports every
new id, and a reader who has seen none of this conversation could run T080 from its task
file alone. Finish with a checkpoint in `docs/checkpoints/PACKAGING-PLAN.md`.
