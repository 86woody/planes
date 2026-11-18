# Round 1 response

Plan author. Date: 2026-11-08. Responds to `round-1.md` (reviewer commit `bf6ecb9`).
I read every direct edit in `git show bf6ecb9`. I keep all 22 of them; there are no
reverts. I applied the five findings that were mine to resolve in this response's commit.

| F | Stance | What changed / why |
|---|---|---|
| F1 | ACCEPT | Kept: composite project references, no `paths`, `tsc -b`; ui and vscode-bridge are non-composite. This is correct and better than mine. |
| F2 | ACCEPT | Kept: `sentAt = performance.timeOrigin`. Spawn order is event order, so this fixes the inversion. |
| F3 | ACCEPT (recommended option) | Browser sessions now persist as SHA-256 digests in `stateDir/browser-sessions.json`, with user-only permissions, a 30-day idle expiry, and atomic writes (api.md 2, config.md 2). `Auth.flush()` was added (internal.md 1) and is called on stop (T027). `mc token rotate` deletes the file (T050 step 8). T015 adds SEC-13 (sessions survive a new `createAuth`, and no raw secrets are on disk). CARD-04 now holds as written, and T033 step 3 says so. |
| F4 | ACCEPT | Kept: exec form with `args`. It removes the shell start-up cost and keeps the agent as the direct parent. |
| F5 | ACCEPT | Kept: `AttachConsole(agent.pid)` fallback. |
| F6 | ACCEPT | Kept: no command-line reads in the hook. |
| F7 | ACCEPT | Kept. |
| F8 | ACCEPT the change, correct the rationale | 11.18.0 is not invented. On dev-pc, `pnpm --version` inside `harness-tools/blackbox` printed 11.18.0 through its corepack pin (2026-11-08). The global version may be 11.2.2. Pinning "the exact output on the build machine" is right either way. |
| F9 | ACCEPT | Kept. |
| F10 | ACCEPT | Kept. |
| F11 | ACCEPT | Kept: `deadHandles`/`startTimes`; PA-05 moved to the OS tasks. |
| F12 | ACCEPT | Kept. |
| F13 | ACCEPT | Kept `taskkill /F`. I declined the optional `POST /api/shutdown` for v1: it adds a route and test surface for a loss of at most 500 ms of snapshot debounce. Revisit if PS-04 ever flakes. |
| F14 | ACCEPT | Kept: verify-then-escalate on macOS 14+, plus M-06. |
| F15 | ACCEPT | Kept: HK-11 and the corrected task IDs. |
| F16 | ACCEPT (compliant by default) | The default no longer puts any code in a URL. `mc open` prints and copies an 8-character `XXXX-XXXX` code (single use, 60 s, one live code, dead after 5 wrong attempts) and opens `http://127.0.0.1:<port>/`. The PAIRING REQUIRED banner holds a code form (DESIGN.md 2; T030 adds UB-07; `BoardActions.pair` and the `Banner` signature are in internal.md 3). Other edits: T032 steps 2 and US-01, T050 step 6 and CLI-05 (`--no-pair` for already-paired browsers and for the notification fallback), T033 `openPaired`, `api.schema.json` code patterns, and T015 SEC-14. D-05 is rewritten: the fragment approach is now the rejected-by-default alternative, pending Woody, with the three task edits it would need listed. PRD Q1 is updated. With F3, pairing happens about once a month per browser. |
| F17 | ACCEPT (documented as a limitation) | attention.md 2.1 states the blind spot. PreToolUse fires before the permission check and nothing fires on the answer. `PermissionDenied` is not hooked (it reports auto-mode classifier denials, not dialog answers). DESIGN.md 4 gives the acknowledged needs_permission card a steady `GO/NO-GO · ACK` label with the hazard band at 50%. T031 `stateLabel` and UC-08 cover it. |
| F18 | ACCEPT | Kept. |
| F19 | ACCEPT | Kept. |
| F20 | ACCEPT | Kept. |
| F21 | ACCEPT | Kept. |
| F22 | ACCEPT | Kept. |
| F23 | ACCEPT | Kept. |
| F24 | ACCEPT (a: long-lived host; b: hidden shim) | (a) There is one long-lived `ps/toast-host.ps1` per daemon run, speaking JSON lines (windows.md 5.2). The first request may take up to 6000 ms and later ones 2000 ms; a timeout restarts the host. PA-07 is amended to match. T042 now owns `toast-host.ts` and `toast-host.ps1` (the three per-call scripts are gone), and adds WU-18. (b) The protocol handler runs `wscript.exe "<stateDir>\restore.vbs" "%1"`, which starts node hidden, so there is no console flash. The VBS rejects arguments that contain a quote or another scheme (WU-17). Foreground rights are not required, because the daemon's key-up trick works without them. W-05 now records that the window lands in front and nothing flashes, and `mc install uri-handler --direct` is the documented fallback (T051 IX-05). The TASKS T042 row and the registry (WU-13..WU-18, T042 7/7) are updated. |
| F25 | ACCEPT | Kept. |
| F26 | ACCEPT | Added `## 5. (reserved)` to internal.md, so the section-6 citations stay valid. |
| F27 | ACCEPT | T002 step 3: if the output for a schema with no root type lacks its `$defs` types, wrap them in a root `anyOf` of `$ref`s inside `generate.mjs` only, and record which path was needed. |

## Count changes

- SEC-01..SEC-14 (T015 now 14/14)
- UB-01..UB-07 (T030 now 7/7)
- WU-13..WU-18 (T042 now 7/7)

The PRD AC-10 and TEST-PLAN registry rows are updated to match.

## Stance

AGREE. No disputes remain. Q1 is Woody's choice, but the plan is compliant without it.
