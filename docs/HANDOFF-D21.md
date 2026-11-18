# Handoff: D-21 (answer agent prompts from a toast or the browser)

Date: 2026-11-15. Repo: `harness-tools/mission-control`, branch `plan/specs`. Planning only: specs and
decisions, no product code. **Nothing is committed.** D-21 edits and `docs/review/round-3*.md` and
`round-4*.md` are uncommitted or untracked.

## What D-21 is

Let a toast or the browser page answer a Claude Code `AskUserQuestion` prompt (and, opt-in, a
permission prompt) by returning a decision from a blocking `PermissionRequest` hook.
Text lives in `docs/DECISIONS.md` lines ~209-391 (revision 3, +184 lines vs HEAD).

## Decisions Woody has made

- Ships inside v1 as milestone **M6**.
- D-12 amended: pending requests are **memory-only**.
- "Other" free text is **page-only** (also on Windows, after S2 came back negative for a reply box).
- AskUserQuestion answers need Woody's own input; opt-in `answers.enabled` defaults off.

## State of the review

| Round | Result |
|---|---|
| 3 | All findings accepted, D-21 rev 2 |
| 4 | 12 findings (F-4-01..12), all accepted, D-21 rev 3; responses in `docs/review/round-4-response.md` |
| 5 | **Not run.** Waiting on spikes S1b and S2b, then a fresh reviewer reviews rev 3 and writes `round-5.md` only |

Plan freezes when a round has zero high/medium findings and both sides AGREE (`docs/review/README.md`).

## D-21 rev 3 design in one paragraph

A second, sync hook `mc-hook answer` (matcher `holdTools`, default `AskUserQuestion`) sits beside the
untouched async D-03 hook. It posts once to `/ingest/v1/requests` and holds over chunked NDJSON frames
(`hb`/`answer`/`cancel`), keyed by `requestId`. Matching is `session_id + tool_name + sha256(tool_input)`.
Answer routes: browser realm, and bearer `answer-toast` with per-toast single-use nonce plus `mc answer <uri>`.
`attention.pendingRequest` is ephemeral. `holdSeconds` default 30. Toast labels capped at 24 chars.
`gate:m6` is fixtures-only; a manual `M6-live` gate is required before M6 is done.

## Probe facts (Claude Code 2.1.322)

- PermissionRequest has no `tool_use_id`; `prompt_id` is shared by all calls in one prompt.
- PostToolUse carries `tool_input`; denied tools emit no Post event.
- While a hook holds, the terminal dialog stays live; a terminal answer does **not** cancel the held hook.
- Auto and acceptEdits modes suppress PermissionRequest for Bash writes. Probe with `--permission-mode default`.
- Windows: `Register-ObjectEvent` cannot subscribe to WinRT events; script-block delegates logged nothing.
  `protocol` toast buttons are the planned route (`restore.vbs` per `docs/platforms/windows.md`).

## Outstanding work, in order

1. **S2b** (Woody, ~3 min). In PowerShell, with `$d` set to the probe folder below:
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$d\s2b.ps1" -Mode setup`, then `-Mode show`.
   Click **Red** on the banner; run `show` again and click **Blue** from Action Center; then `-Mode cleanup`.
   Pass criterion: `s2b-events.jsonl` has a `stub-launched` line per click, no listener running, no console flash.
2. **S1b** (Woody). `cd "$d\work"; claude --permission-mode default --settings "$d\settings4.json"`
   (status line must say default). Cases: single-question AskUserQuestion (answer inside the hold, and after
   it expires); multi-select; Bash approved in terminal during hold; Bash denied in terminal;
   two parallel Bash calls. Optional 600 s hold: write `600` to `hold-seconds.txt`.
   Read `hold-events.jsonl` and `events.jsonl`.
3. Fold S1b/S2b results into D-21, correct any rev 3 claim they contradict.
4. Run round 5 (fresh reviewer). If clean: draft contract amendments (AC-11, HK-01..10, D-06, D-11, schemas,
   `claude-hooks.md`, `windows.md` 5.2 and 5.3, SEC-27) and M6 task files.
5. Commit only on Woody's say-so: feature branch, **no co-author trailer** (workspace rule, overrides the
   harness attribution reminder).

## Probe kit

`$d` = `C:\Users\you\AppData\Local\Temp\claude\b18f87cd5c3dcc7a\a69ee60a-b2b6-452e-93eb-1d8965c8f129\scratchpad\probe`

Scratchpad, so session-scoped and may vanish; copy anything worth keeping.
`hold.js` + `settings4.json` (S1b), `s2b.ps1` (S2b; selftest passes), `log.js`, `answer.js`, `s1.js`,
`s2-toast.ps1`, plus earlier logs `events.jsonl`, `answer-events.jsonl`, `s1-events.jsonl`, `s2-events.jsonl`.
Rev sources: `scratchpad\d21-rev2.md`, `d21-rev3.md`.

## Loose ends

- Registry key `HKCU\Software\Classes\AppUserModelId\WoodyDeus.MissionControl.S2` left from S2; remove with
  `s2-toast.ps1 -Mode cleanup` (Woody has not answered). S2b cleanup removes its own keys and the `mc-s2` scheme.
- S2 V2 text-box visibility unconfirmed.
- Peer sessions involved earlier: `scratch-58`, `work-f7`.

## Rules to respect

- Do not install hooks into the real `~/.claude/settings.json` (mission-control AGENTS.md); use `--settings` only.
- Never read `.env` or credential stores; no token in a URL.
- Interactive `claude` cannot run via the `!` prefix; use a separate PowerShell window.
- Full history: `C:\Users\you\.claude\projects\C--Users-woody-Workspace\a69ee60a-b2b6-452e-93eb-1d8965c8f129.jsonl`.
