# Working on mission-control

This file says how to work here, never what the product is (that is `README.md` and
`docs/PRD.md`). Every agent obeys it: orchestrator, builder, validator, reviewer.

## Read order

1. This file.
2. Your task file `docs/tasks/T###.md` (builders read nothing else unless the task
   file names it).
3. The contracts the task file lists under "Codes against", in `docs/contracts/`.

If something you need is not in those three, stop and report (see "Stop rules").
Do not go looking through other tasks' files or guess.

## Branches

| Branch | Who writes | Rule |
|---|---|---|
| `master` | orchestrator only, merges from `integration` at milestone tags | never commit directly; tagged `m0`..`m5` |
| `integration` | orchestrator only, merges task branches | typecheck, lint and the merged task's `npm run task:check` green after every merge, or the merge is reverted; milestone gates at wave ends (`docs/ORCHESTRATION.md` 4) |
| `task/T###-<slug>` | exactly one builder | based on current `integration`; one task per branch |
| `plan/*` | plan author and reviewer | docs only |

Never commit to `master` or `integration` yourself unless you are the orchestrator.
Never push anywhere unless the orchestrator tells you to. Never rebase a branch you
did not create. No `Co-Authored-By` or other trailers in commit messages.

## Stack lock

Node >= 22 (tested on 22 and 24), npm >= 9 with npm workspaces (`packageManager`
pinned in the root `package.json`, which also lists the workspaces in build order; D-60), TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, ESM only, Vitest, Playwright, Fastify 5 with
`@fastify/websocket`, Ajv 8, React 19 + Vite for the UI, `koffi` for Win32 FFI,
`dbus-next` for Linux D-Bus. Adding any other runtime dependency is a contract change
(see `docs/DECISIONS.md` D-01, D-02). Dev dependencies a task file names are fine.

## Frozen files (read-only for builders)

- everything under `docs/` (except your own `docs/checkpoints/T###.md`)
- `packages/contracts/**` after T002 merges
- `packages/platform/src/types.ts` and `packages/platform/test/conformance.ts` after T003
- root `package.json`, `package-lock.json`, `tsconfig.base.json`, `vitest.config.ts`,
  `eslint.config.js`, `scripts/gate.mjs` after T001/T004
- every file another task owns (the "Owns" column of `docs/TASKS.md`)

A builder that needs a frozen file changed writes the request in its checkpoint file
as `CR: <file> <what> <why>` and stops. It never works around a contract.

## Definition of done for a task

1. The task's single **acceptance command** prints the expected output and exits 0 in
   your worktree.
2. `npm run typecheck` and `npm run lint` exit 0.
3. You touched only the files under "Files" in your task (`git diff --name-only
   integration...HEAD` is a subset of that list plus `docs/checkpoints/T###.md`).
4. You wrote `docs/checkpoints/T###.md`: what works, what does not, what surprised
   you, the acceptance command output (last 20 lines).

## Commands

```
npm install                         # once per worktree
npm run typecheck
npm run lint
npx vitest run <path>               # one test file
npm run gate:m0 .. npm run gate:m4  # milestone gates (orchestrator/validator)
npm run gate                        # the project gate, m5 (orchestrator/validator)
npm run task:check T###             # one task's tests
npm run mc -- <command>             # the CLI from a clone (same as `mc`)
```

## Test hygiene

- Tests never touch the real config or state dirs. Set `MC_HOME=<tempdir>`; every
  path in the product derives from it when set (`docs/contracts/config.md`).
- Tests never focus real windows or raise real notifications unless the file is under
  `packages/platform/test/os/` and the env var `MC_OS_TESTS=1` is set.
- Tests never bind a fixed port; use port 0 and read the bound port.
- No test sleeps longer than 2 s; use fake timers (`vi.useFakeTimers()`).

## Stop rules

Stop and write your checkpoint (do not improvise) when: a contract is ambiguous or
wrong; the acceptance command cannot pass without touching a file you do not own; a
dependency task's output is missing or broken; you have failed the acceptance command
three times with different fixes.

## Workspace rules that apply here

`hostname` before anything destructive (two workstations share this path). Never read
`.env` files or credential stores. More than one agent writing: the orchestrator has
read `C:\Users\you\Workspace\.claude\skills\serialize-writes\SKILL.md`; builders
follow `docs/ORCHESTRATION.md`.
