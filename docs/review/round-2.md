# Review round 2

Reviewer: adversarial reviewer (Claude). Date: 2026-11-08. This round reviews the
author's response `round-1-response.md` and commit `5e24dc1`.

## Verdict: APPROVE

I accept every response row. The F8 rationale correction is fair: corepack pins 11.18.0
inside blackbox, and the "pin what `pnpm --version` prints" rule covers both versions.
Declining F13's shutdown route is reasonable. The F17 limitation is now stated
honestly, and the acknowledged-state visual makes it legible on the card.

I re-simulated a Haiku builder on every task the response touched: T002, T015, T026,
T027, T030, T031, T032, T033, T042, T050 and T051. I also cross-checked the contracts
the response changed: api.md, api.schema.json, internal.md, attention.md, config.md,
platform-adapter.md and windows.md.

That re-simulation found four new problems in the response's own changes, and one
pre-existing bug the persistent sessions made worse, which I missed in round 1. They
are concrete, so I fixed all five in this round's commit rather than sending them back.
There are no blockers left.

## Findings

| F | Severity | Location | Problem | Action |
|---|---|---|---|---|
| F-2-01 | major | api.md 2, T015, T032 step 1 | The CSRF token lived only in `sessionStorage` (one tab) and on disk only as a digest. With cookies persisting 30 days (F3), a new tab or a browser restart holds a valid cookie but no CSRF. `GET /api/state` succeeds, so no pairing banner appears, yet every RESTORE, ACK or DISMISS returns 403. The page looks paired and silently does nothing. This existed in round 1 but was hidden behind re-pairing on every restart. | **Changed.** The CSRF is now derived rather than random: `base64url(HMAC-SHA256(token, cookie))`, so it is never stored. A new `GET /api/csrf` (browser realm) returns it to a same-origin tab with a valid cookie. That is safe because no CORS headers are sent and the Host check blocks rebinding. Contract changes: `Auth.csrfFor()` added; `browser-sessions.json` drops `csrfSha256`. The store fetches the CSRF when it has none, and on a 403 refetches it once and retries once. Tests added: SEC-15 (T015 15/15), API-13 (T026 19/19), US-11 (T032 11/11); registry and PRD AC-10 updated. Rotating the token also invalidates every CSRF. |
| F-2-02 | major | T050 step 8 | `token rotate` deleted `browser-sessions.json` while the daemon kept running. On the next clean stop, `stop()` calls `auth.flush()` (added by the response to T027) and writes the old sessions back, so rotation would not de-pair browsers. | **Changed.** `token rotate` stops a running daemon first, then rewrites the token and deletes the file. The message tells Woody to run `mc start` and `mc open`. |
| F-2-03 | major | T033 step 3 (CARD-04) | The e2e daemon runs with `MC_PORT=0`. A restart therefore gets a new ephemeral port, while the open page keeps reconnecting to its own origin's port, so CARD-04 could never see the page recover. A Haiku builder would hit a stop rule. | **Changed.** CARD-04 restarts with `MC_PORT=<first run's port>` and the same `MC_HOME`. |
| F-2-04 | minor | windows.md 5.2, T042 step 3 | The long-lived toast host reads JSON on redirected stdin. Windows PowerShell 5.1 decodes that in the OEM code page, and every NP-13 title contains `·`, so every title would arrive mangled. | **Changed.** The host sets `[Console]::InputEncoding`/`OutputEncoding` to UTF-8 (no BOM) before its first read. WU-18 also asserts that the request line is valid UTF-8. |
| F-2-05 | minor | api.md 2 | The cookie's `Max-Age` (30 days) is fixed at pairing, while the server-side session expires after "30 days idle". An active browser therefore loses its cookie 30 days after pairing, regardless of use. That matches the response's "pairing about once a month". | **Not changed; noted.** Acceptable for v1. If monthly re-pairing annoys Woody, re-issue `Set-Cookie` on `GET /api/state` at most once a day. |

I checked these and found them sound:
- The pairing code: Crockford alphabet, a lower-case-tolerant pattern, 40 bits of
  entropy, 60 s lifetime, single use, killed after 5 wrong attempts, and the pair rate
  limit.
- The `restore.vbs` guard: it checks for exactly 18 characters of `mission-control://`
  and rejects any argument containing a quote. `WScript.Shell.Run` expands `%VAR%`, but
  a URL-encoded id contains at most one `%`, and nothing worse than an odd restore id
  can be injected.
- PA-07 is amended consistently in platform-adapter.md, windows.md and T042.
- The Owns and registry rows for T042 match.
- The T002 codegen fallback stays inside `generate.mjs`.
- The `Banner` and `BoardActions` signature changes are consistent across internal.md,
  T030, T032 and T033.
- No stale `#pair=` references remain outside the alternative described in D-05.
- Expected `PASS n/n` counts still equal the titled IDs and the registry, after this
  round's additions.

## Open for Woody (not blocking)

- Q1/D-05: whether to waive "never a token in a URL" for a single-use fragment code.
  The plan complies as written.
- Q2-Q6 as listed in the PRD.

## Stance

**AGREE.** With this round's commit, I would hand the plan to Haiku builders tomorrow.
