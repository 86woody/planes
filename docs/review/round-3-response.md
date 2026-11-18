# Review round 3 response

Author: plan author (Claude). Date: 2026-11-11. Responds to `round-3.md`. Every change is
in D-21 revision 2 (`docs/DECISIONS.md`); no contract file was edited, because D-21 is
still a draft and its amendments land in one commit on acceptance. Nothing is committed.

| F | Response | What changed or why not |
|---|---|---|
| F-3-01 | ACCEPT | Confirmed in the probe log: `PermissionRequest` has no `tool_use_id`. D-21 point 2 now uses a daemon-minted `requestId` and matches `PostToolUse` by `session_id` + `tool_name` (FIFO) or by `prompt_id` if S1 shows it is stable. The `ingest.md` amendment is listed for acceptance. |
| F-3-02 | ACCEPT | "Probe results" re-scoped (auto mode, one machine, Claude Code 2.1.322, Q3 from one run, Q4 conditional, Q5 unlearned). The Allow/Deny/`message`/`interrupt` path is stated as unverified and becomes spike S1. |
| F-3-03 | ACCEPT | One hook replaces the async one for PermissionRequest when `answers.enabled`. No `onFailure`; `timeout = holdSeconds + 10`; the gate asserts the installed JSON. |
| F-3-04 | ACCEPT | Point 7: pending map only, no spool path, nothing in state, logs or broadcast, toast text is tool name and question header only (a stricter fix than the reviewer's 120-character option), sentinel-grep test. |
| F-3-05 | ACCEPT | Point 4: browser realm only, daemon builds the decision, single use, expiry, rate limit, 410 on late answer, toast replies over the host's authenticated pipe, SEC-16..SEC-24. |
| F-3-06 | ACCEPT | Point 8 and spike S2, with the protocol-button fallback and Other page-only on Windows if the reply cannot be read. |
| F-3-07 | ACCEPT | Point 3 is the held-request protocol: transport, heartbeat, give-up times, cap of 8, dedupe key, restart behaviour, late-answer text. |
| F-3-08 | ACCEPT | Point 5: toast Allow only for `answers.allowTools` (default AskUserQuestion), explicit `interrupt: false`, default deny message. |
| F-3-09 | ACCEPT | Point 6: unique question text, single-select only on the toast, multi-select page-only until S1 records it; worked JSON examples after S1. |
| F-3-10 | ACCEPT | Point 9 gives the `awaiting_answer` delta. The exact SM rows are drafted in the acceptance commit, not before. |
| F-3-11 | ACCEPT | Point 8: per-OS capability bits `answerButtons` and `answerText`, no-capability fallback, eviction exemption. |
| F-3-12 | ACCEPT | Point 10 defines `pnpm gate:m6` with fixtures, fake-platform click, fail-open test and the sentinel grep. |
| F-3-13 | ACCEPT | The list of documents rewritten on acceptance is in D-21, and the installer registers the sync hook only when `answers.enabled` is true. Not drafted yet by design. |
| F-3-14 | ACCEPT | Stale paragraph and the answered open-questions list removed. |

Not AGREE yet: round 4 should review revision 2 after spikes S1 and S2 have results.
