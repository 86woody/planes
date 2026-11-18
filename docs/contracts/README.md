# Contracts

These files are what every builder codes against. They are **frozen** when the plan
freezes (`docs/review/README.md` rule 2). After that, a change needs a decision entry
`D-nn: Amends docs/contracts/<file>` and the orchestrator re-runs every merged task's
acceptance command that lists the file under "Codes against".

| File | Defines | Package that carries it |
|---|---|---|
| `session.schema.json` | `Session` and its sub-types (`SessionId`, `State`, `Attention`, `Host`, `FocusResult`, `RestoreReason`) | `@mc/contracts` |
| `ingest.schema.json`, `ingest.md` | `IngestEnvelope`, `IngestOrigin`, the hook protocol, env and payload allowlists, host classification rules | `@mc/contracts`, implemented by `@mc/hook` and `@mc/core` |
| `attention.md` | reducer signature, transition table (SM-nn), notify policy (NP-nn) | implemented by `@mc/core` |
| `api.schema.json`, `api.md` | daemon HTTP routes, auth realms, WebSocket messages | implemented by `@mc/daemon`, consumed by `@mc/ui`, `@mc/cli` |
| `platform-adapter.md` | `PlatformAdapter` interface, behavioural rules (PA-nn), `FakePlatform` | `@mc/platform` |
| `vscode-bridge.md` | bridge WebSocket protocol, binding and matching rules | `@mc/daemon`, `@mc/vscode-bridge` |
| `config.schema.json`, `config.md` | config file, directories, state files | `@mc/daemon`, `@mc/hook`, `@mc/cli` |
| `claude-hooks.md` | the exact hook entries `mc install claude-code` writes | `@mc/cli` |
| `internal.md` | module seams between parallel tasks: daemon services, UI components, CLI commands, the stub list | all packages |

## How the schemas become code (T002)

- `packages/contracts/schemas/*.json` are byte-for-byte copies of the `*.schema.json`
  files here plus `bridge.schema.json` transcribed from `vscode-bridge.md`.
- `packages/contracts/src/generated/*.ts` are generated with `json-schema-to-typescript`
  (`npm run generate -w @mc/contracts`) and committed.
- Exported TS names: `Session`, `SessionId`, `State`, `Attention`, `AttentionReason`,
  `Host`, `HostKind`, `RestoreReason`, `FocusResult`, `IngestEnvelope`, `IngestOrigin`
  (from `$defs.Origin`), `ProcessInfo`, `Config` (resolved, all properties required),
  `ConfigFile` (as written, all optional), and every `$defs` name of `api.schema.json`
  and `bridge.schema.json`.
- Validators: `validateSession`, `validateEnvelope`, `validateConfig` (applies
  defaults), `validateWsServerMessage`, `validateBridgeClientMessage`,
  `validateBridgeServerMessage`, each `(x: unknown) => {ok: true, value: T} | {ok: false, errors: string[]}`.
- `contracts.lock.json` holds the SHA-256 of every schema file; test `CT-01` fails
  when a schema changes without the lock being regenerated, which only the
  orchestrator does, with a D-nn.

## Version

All wire formats carry version 1 (`v: 1` on envelopes, `protocol: 1` on the bridge,
`/ingest/v1`, `/bridge/v1`). A breaking change is a new version served side by side.
