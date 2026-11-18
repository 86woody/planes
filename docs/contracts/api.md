# Contract: daemon HTTP and WebSocket API

Status: FROZEN at plan freeze. Body types: `api.schema.json` `$defs.<Name>`.
Base URL `http://127.0.0.1:<port>` (default port 47800). JSON everywhere, UTF-8.

## 1. Global middleware (applied before routing, in this order)

| Order | Check | Failure |
|---|---|---|
| 1 | `Host` header is exactly `127.0.0.1:<port>` or `localhost:<port>` | `421` `Error{code: bad_host}` |
| 2 | Method `OPTIONS` | `405`, no CORS headers |
| 3 | Route auth realm (section 2) | `401` `unauthorized` (no credential) or `403` `forbidden` (bad credential, bad Origin, missing CSRF) |
| 4 | Body size: 16 KiB for `/ingest`, 4 KiB otherwise | `413` |
| 5 | Rate limit (section 4) | `429` `rate_limited` |

Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`; HTML responses also
`Content-Security-Policy: default-src 'self'; connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`.
Never `Access-Control-Allow-*`.

## 2. Auth realms

| Realm | Credential | Accepted when |
|---|---|---|
| `none` | - | always |
| `bearer` | `Authorization: Bearer <token>`, token = `<stateDir>/token` contents | token matches (constant-time compare) **and** no `Origin` header, or `Origin` is in the realm's allowed list |
| `browser` | cookie `mc_session=<id>` + header `X-MC-CSRF: <csrf>` on non-GET | cookie maps to a live browser session; for non-GET the CSRF matches that session; `Origin` (if present) is `http://127.0.0.1:<port>` or `http://localhost:<port>` |
| `browser-or-bearer` | either of the above | |

Browser sessions: created by `/api/pair`, expire after 30 days idle. They survive daemon
restarts (F3, round 1): the daemon keeps them in memory and persists only digests to
`stateDir/browser-sessions.json` (`[{"cookieSha256": hex, "lastSeen": ms}]`,
user-only permissions like `token`, rewritten atomically at most once a minute and on
pair/expiry/shutdown). The CSRF token is not stored at all: it is derived,
`csrf = base64url(HMAC-SHA256(key = token file contents, msg = cookie value))` (43 chars),
so the daemon can hand it again to any tab that holds a valid cookie (`GET /api/csrf`,
round 2) and a browser restart, a new tab or a cleared `sessionStorage` never leaves the
page paired-but-unable-to-POST. A request is checked by hashing the presented cookie
and comparing digests, then recomputing the HMAC and comparing it with `X-MC-CSRF`
(both constant time). `mc token rotate` deletes the file, so every browser
must pair again. Cookie attributes:
`HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (no `Secure`: plain-HTTP loopback).
The `token` file is 32 random bytes as base64url (43 chars), created on first start
with user-only permissions (ARCHITECTURE.md S3), never rotated automatically;
`mc token rotate` rewrites it and disconnects bridges.

## 3. Routes

| Method, path | Realm | Request | Response |
|---|---|---|---|
| `GET /healthz` | none | - | `200 Health` |
| `GET /` and `/assets/*` | none | - | the built UI (`packages/ui/dist`); unknown asset `404` |
| `POST /api/pair-code` | bearer | - | `200 PairCodeResponse` (single use, 60 s; a new code invalidates the previous one) |
| `POST /api/pair` | none (`Origin` must be the daemon's own, else 403) | `PairRequest` (the code Woody types or pastes into the page; never part of a URL, D-05) | `200 PairResponse` + `Set-Cookie`; unknown/expired/used code `401 pair_expired`; after 5 wrong attempts against the live code it is invalidated |
| `GET /api/csrf` | browser (cookie; GET, so no CSRF header needed) | - | `200 PairResponse` (`{csrf}` for the presented cookie). Safe to serve on GET: no CORS headers are ever sent, so a cross-origin page cannot read it, and the Host check stops rebinding |
| `GET /api/state` | browser-or-bearer | - | `200 StateResponse` |
| `POST /api/sessions/:id/restore` | browser-or-bearer | `{}` or `{"source": "notification"}` | `200 RestoreResponse`; unknown id `404` |
| `POST /api/sessions/:id/ack` | browser-or-bearer | `{}` | `200 SessionResponse`; unknown id `404` |
| `GET /api/sessions/:id/traces` | browser-or-bearer | - | `200 TracesResponse` (D-57; `runs: []` when none); unknown id `404` |
| `DELETE /api/sessions/:id` | browser-or-bearer | - | `204`; only for state ended or lost, else `409 invalid_request` |
| `POST /api/notify/test` | browser-or-bearer | `{}` | `200 {"sent": boolean, "backend": string}` sends "MISSION CONTROL · COMMS CHECK" |
| `GET /api/ws` (upgrade) | browser (cookie; Origin required and must be the daemon's) | - | WebSocket, section 5 |
| `POST /ingest/v1/events` | bearer | `IngestEnvelope` | `202 {"accepted": true, "sessionId": SessionId}`; schema failure `400 invalid_envelope` |
| `GET /bridge/v1` (upgrade) | bearer (Origin absent or `vscode-file://vscode-app`) | - | WebSocket, `vscode-bridge.md` |
| `GET /api/test/fake-platform` | bearer, only when `MC_TEST=1` and `MC_PLATFORM=fake` | - | `200 {"calls": FakeCall[]}` (`platform-adapter.md` 5); otherwise `404` |
| `POST /api/test/fake-platform/foreground` | bearer, same guard | `{"sessionId": SessionId \| null}` | `204`; makes the fake report that session's window as foreground |

`:id` is URL-encoded `SessionId` (the colon is encoded as `%3A`; the daemon also
accepts it raw).

## 4. Rate limits

- `restore`: 2 per second per session, 5 per second total; excess returns `429` and
  the session's `restore.lastResult` is not changed.
- `pair`: 10 per minute total.
- `ingest`: 200 per second total (excess `429`; the hook spools).

## 5. WebSocket `/api/ws`

- On open the server sends `hello` with the full `StateResponse` and its `seq`.
- Every later message has `seq` = previous + 1 (one global counter across all message
  types). A client that sees a gap closes the socket and reconnects (which yields a
  fresh `hello`).
- Messages: `WsServerMessage` (`session.upsert`, `session.remove`, `daemon.update`,
  `notify`, `highlight`). Clients send only `{"type": "ping"}`; the server answers
  nothing (the ping only keeps intermediaries alive); any other client message closes
  the socket with code 1008.
- Server pings at the protocol level every 20 s; no pong within 10 s closes the socket.
- Upserts are coalesced per session to at most one per 100 ms (latest wins).

## 6. Status codes for restore results

`POST /restore` always returns 200 when the session exists, even if focusing failed;
the outcome is in `result` (`FocusResult`). HTTP errors are reserved for auth, unknown
session and rate limits.
