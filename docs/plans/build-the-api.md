# Plan: build the daemon API from scratch

**Audience:** a build agent with an empty checkout and this repo's `docs/contracts/` only.
**Done means:** `npm run gate` exits 0 and `GET /healthz` answers from a started daemon (see Gate).

## What you are building
The mission-control daemon's HTTP + WebSocket API, `packages/daemon`, on `127.0.0.1:47800`.
The contract is frozen: `docs/contracts/api.md` (behaviour) and `api.schema.json` (bodies).
When code and contract disagree, the contract wins. Change code, not the contract.

Routes: `GET /healthz`, `GET /` + `/assets/*` (built UI), `POST /api/pair-code`, `POST /api/pair`,
`GET /api/csrf`, `GET /api/state`, `POST /api/sessions/:id/restore`, `POST /api/sessions/:id/ack`,
`GET /api/sessions/:id/traces`, `DELETE /api/sessions/:id`, `POST /api/notify/test`,
`POST /ingest/v1/events`, `GET /bridge/v1`, `GET /api/ws` (WebSocket).

## Order of work (each step ends green before the next starts)
1. **Toolchain.** Node 24, `npm ci`, `node scripts/check-toolchain.mjs`.
2. **Contracts package.** `packages/contracts`: generate TS types and validators from the five
   `*.schema.json` files. Every request and response body is validated through them. Run `vitest --project contracts`.
3. **Core logic.** `packages/core`: session state, attention rules, classification, callsigns. Pure functions, no I/O.
   Run `vitest --project core`.
4. **Server skeleton.** `app.ts` (Fastify): the middleware order in api.md section 1 exactly:
   Host check (421), OPTIONS (405), auth realm (401/403), body limit (16 KiB ingest, 4 KiB else), rate limit (429).
   Every response sets `Cache-Control: no-store`, `nosniff`, `no-referrer`. Never emit CORS headers.
5. **Auth.** `auth.ts`: realms `none`, `bearer`, `browser`, `browser-or-bearer`. Token file is 32 random bytes,
   base64url, user-only permissions. Constant-time compares. Cookie `mc_session`
   (`HttpOnly; SameSite=Strict`), CSRF derived as HMAC-SHA256(token, cookie), never stored. Pair codes are single use, 60 s.
6. **Routes, one file each** under `src/routes/`: `api`, `ingest`, `bridge`, `pair`, `static`. Unknown id gives 404;
   deleting a live session gives 409. Add a test beside each route before wiring it.
7. **State.** `sessions.ts`, `persistence.ts` (atomic writes), `liveness.ts`, `notifier.ts`, `traces.ts`.
8. **WebSocket.** `ws.ts`: `GET /api/ws`, one wire sequence counter, snapshot then deltas.
9. **Hook + integration.** `packages/hook` posts envelopes to `/ingest/v1/events`;
   `vitest --project daemon-integration` drives hook -> daemon -> state end to end.

## Rules
- Contract first, test second, code third. A route with no test does not count.
- Loopback only. No secret or token ever appears in a URL, a log line or a test fixture.
- Do not edit `docs/contracts/*` or the generated `packages/contracts/src/generated/*` by hand.
- Do not add dependencies beyond `package.json` without a note in `docs/DECISIONS.md`.

## Gate (the one command)
```
npm run gate        # exits 0: typecheck, lint, contracts, core, daemon, hook, integration, ui
npm run build && node packages/cli/dist/mc.js start && curl -s http://127.0.0.1:47800/healthz
```
Falsifiable: gate exits non-zero, or `/healthz` returns anything but `200 Health`, means not done.

## Push
Branch `api-from-scratch`, one commit per numbered step, then
`git push origin api-from-scratch` and open a PR to `master`. This repo is public: before pushing run
`git diff --stat origin/master` and confirm no `.env`, token, state dir, screenshots or evidence files are included.
Report back: branch name, commit SHA, path of `packages/daemon`, gate output tail.
