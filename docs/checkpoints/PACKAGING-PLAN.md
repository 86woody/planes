# Checkpoint: packaging plan (2026-11-15)

Branch `plan/packaging` (worktree `.worktrees/mission-control/packaging`), from
`integration` at 5bf202b. Docs and plans only; no product code changed.

## How it was made

The orchestrator (Opus) ran three Sonnet research agents (distribution form, installer
paths, vsix/versioning/plan format), then four Sonnet task writers in parallel, each owning
its own task files plus a staging file, then one Sonnet review pass. The orchestrator was
the only writer of shared files: DECISIONS, PACKAGING, contracts, TASKS, TEST-PLAN,
`scripts/test-ids.json` and HANDOFF.

## Woody's decisions (2026-11-15)

- **Distribution:** an npm tarball `mission-control-desktop`, attached with the `.vsix` to a
  forge release. Nothing is published to a registry.
- **Hook stability:** a stable launcher in `stateDir/bin` plus repair in place.
- **Fresh-machine proof:** Windows Sandbox on dev-pc.

## Output

- `docs/DECISIONS.md` D-39..D-45.
- `docs/PACKAGING.md`, the frozen spec: package layout, layout module API, launcher format,
  user flow, verification matrix and file owners.
- `docs/contracts/config.md`, which gains `stateDir/bin/` and records the shell installer's
  `adapters.shell.enabled` write.
- `docs/contracts/claude-hooks.md`, where `<HOOK_JS>` is now the launcher and removal and
  idempotence go by the identification rule.
- `docs/tasks/T080.md`..`T091.md`. T091 is orchestrator-only.
- `docs/TASKS.md`:
  - an "M5 packaging" milestone row;
  - waves 8a-8i, plus the missing wave 7 row;
  - task rows T080-T091.
- `docs/TEST-PLAN.md`:
  - a `package` stage (m5) and a `packaging` Vitest project;
  - registry rows VR, LY, RW, LN, RP, PC, VX, PK, RN, SK and SB;
  - manual FM-01..FM-08 rows.
- `scripts/test-ids.json`: 397 to 511 IDs (114 new, all m5, os `any`).
- `HANDOFF.md` blocker 5, now pointing at the plan.

## Verified

- `pnpm task:check` was run for every existing task (T001-T072). All pass. T020 and T027
  pass after their own acceptance-command build step, because this worktree had no `dist/`.
- `pnpm task:check T080` prints `FAIL 0/16` (registered, not built), not `UNKNOWN`.
- The audit (`check-test-ids.mjs --gate m5`) now requires 498 IDs on Windows (384 + 114).
  `--gate m4` still requires 383, so earlier gates are unaffected.
- A script checked each new ID's title and file against its task file. The only flagged
  rows were LN-01..LN-13, a false positive: T083 lists its test files with brace syntax.

## Open, for the orchestrator running wave 8

- T080 commits a `pnpm-lock.yaml` change (root esbuild). Re-run `pnpm install` on any lock
  conflict at merge.
- Merge T083 and T084 back to back: between them, claude, copilot and codex record
  launcher paths without writing the launchers.
- The `package` stage needs npm registry access.
- A hand-run macOS `pnpm gate` will report the SK IDs missing (PACKAGING.md 6).
- T081's LY-09 relies on `cli/dist` and `daemon/dist` existing from earlier gate stages
  (typecheck emits them). It holds by stage order only.
- Pre-existing gaps, not packaging scope:
  - DR-06 "no event received" is in claude-hooks.md but not in code (D-42 Open).
  - TEST-PLAN section 4 still lacks CP-01..CP-14 and CX-04, which are in the JSON.
- Not committed and not pushed.
