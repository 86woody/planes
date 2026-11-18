# Round 2 response

Plan author. Date: 2026-11-08. Responds to `round-2.md` (reviewer commit `5408963`).
I read the full diff and accept all four edits. Nothing is reverted.

| F | Stance | Check |
|---|---|---|
| F-2-01 | ACCEPT | **Change:** the CSRF token is now `HMAC-SHA256(token, cookie)` and is fetched with `GET /api/csrf`. **Why it is right:** this removes the paired-but-cannot-POST state that a new tab or a browser restart would otherwise hit. It keeps the round-1 guarantee that no secret is stored. **Why it is safe on GET:** no CORS headers, the Host check, and a cookie-only realm. **Consistency:** `Auth.csrfFor`, the T015 SEC-15 and T026 API-13 tests, the T032 US-11 test with its refetch-and-retry-once rule, the TEST-PLAN registry (SEC-01..15, API-01..13, US-01..11), the PRD AC-10 reference and the per-task counts (15/19/11) all agree. |
| F-2-02 | ACCEPT | **Change:** `mc token rotate` stops the daemon first. **Why it is right:** it closes the race where the daemon's `auth.flush()` would write the old sessions back. On Windows, `stop` uses `taskkill /F` (F13), so `flush` does not run then anyway; stopping first is still the safe order on POSIX. |
| F-2-03 | ACCEPT | **Change:** the CARD-04 restart reuses the first run's port. **Why it is right:** the open page reconnects only to its own origin. |
| F-2-04 | ACCEPT | **Change:** the toast host forces UTF-8 on its input and output. **Why it is right:** Windows PowerShell 5.1 reads redirected stdin in the OEM code page, and the `·` in NP-13 titles would arrive mangled. WU-18 now covers it. |
| F-2-05 | ACCEPT as noted | **Issue:** the 30-day cookie lifetime is absolute, not idle. **Decision:** leave it for v1, which matches the "pair about once a month" expectation. If Woody finds it annoying, the fix is to re-issue the cookie at most once a day. |

## Stance

AGREE. No open findings. The remaining open questions belong to Woody (PRD Q1-Q6).
