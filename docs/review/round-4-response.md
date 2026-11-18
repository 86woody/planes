# Review round 4 response

Author: plan author (Claude). Date: 2026-11-11. Responds to `round-4.md`. Every change is
in D-21 revision 3 (`docs/DECISIONS.md`); no contract file was edited. Nothing is committed.

One structural change to note: round 3's F-3-03 fix ("one hook replaces the async one") is
reversed. The async D-03 hook now stays untouched and a second sync hook posts only to the
requests route. That removes the double-ingest problem F-3-03 raised and also removes the
AC-11 and HK-01..10 contradiction in F-4-09, because the async hook is unchanged.

| F | Response | What changed or why not |
|---|---|---|
| F-4-01 | ACCEPT | Real gap. Point 4 adds `POST /api/requests/:id/answer-toast` (bearer realm, buttons only, per-toast nonce in the URI, single use) and `mc answer <uri>`. The stale pipe sentence is gone. Linux and macOS callbacks call the answer function in-process. SEC rows extended to SEC-27; windows.md 5.3 is on the acceptance list. |
| F-4-02 | ACCEPT | `PreToolUse` dropped from the clear list. Matching is `session_id + tool_name + sha256(tool_input)`, parallel-safe. SM-09 mention deleted in the delta table. Terminal-denied requests are bounded by `holdSeconds`. |
| F-4-03 | ACCEPT | Point 10: `gate:m6` is declared fixtures-only and says so; a manual `M6-live` gate on the tower with the real hook and daemon is required before M6 is done. Fixtures added: parallel same-tool requests, duplicate key. Default-mode AskUserQuestion is spike S1b. |
| F-4-04 | ACCEPT | Point 3: `cancel` frame on every clear, stdout only after an `answer` frame, duplicate key cancels the old request, `ended` and `lost` added to the clear list. |
| F-4-05 | ACCEPT | Probe section rewritten claim by claim to what the files show (2 runs, `annotations` on every terminal answer, no Notification in the held run, S1 observations attributed to Woody, version noted as shell output, S2 no click evidence, two-question probes only). S2 re-run with a logged click is folded into S2b. The Register-ObjectEvent and compiled-sink attempts are described as unrecorded. |
| F-4-06 | ACCEPT | Point 1: sync hook matcher `holdTools` defaults to `AskUserQuestion` only; Bash and other prompts untouched until S1b shows the terminal stays usable during a hold. `holdSeconds` default 30. |
| F-4-07 | ACCEPT, with one change | Labels stay on buttons (a blind "Yes/No" is unusable) but are capped at 24 characters, question text is never on a toast, and `toastShowsLabels=false` numbers the buttons. The exposure in OS history is stated as accepted, not hidden. OPEN consumes a button; over the cap means page-only. |
| F-4-08 | ACCEPT | Point 4: body shapes per request kind, `resolvedBy` on 410, "sent, waiting for Claude" until confirmed, rate limit per session or token, "wrong session" test replaced by wrong request id and kind mismatch. |
| F-4-09 | ACCEPT | Point 3: chunked NDJSON frames over Node `http`; over the cap there is no hold and no request; one POST to `/ingest/v1/requests` only; the hook never spools. AC-11 and HK are exempted on acceptance for `mc-hook answer` only. |
| F-4-10 | ACCEPT | Point 9: `attention.pendingRequest` is ephemeral (not persisted, not logged, cleared on load); the SM delta is now a table. The broadcast may carry `{requestId, kind}`, a random id with no content; point 7 says so. |
| F-4-11 | ACCEPT | Acceptance list extended (AC-11, HK, D-06, D-11, schemas, windows.md 5.2 and 5.3, `claude-hooks.md`). S2b added: a `protocol` button click end to end. S2 is no longer described as the whole answer. |
| F-4-12 | ACCEPT | No Allow button for AskUserQuestion; header capped at 24 characters. |

Not AGREE yet: round 5 should review revision 3. Two items need Woody: spikes S1b and S2b.
