# Contract: paths, config file, state files

Status: FROZEN at plan freeze. Implemented in `packages/daemon/src/paths.ts` and
`config.ts` (T014); `packages/hook` (T020) and `packages/vscode-bridge` (T052)
reimplement the `paths` rules (small, duplicated on purpose so the hook loads no
daemon code). All three are tested against the same fixture,
`packages/daemon/test/fixtures/paths.json`: CF-01 (daemon), HK-11 (hook), VB-08 (bridge).

## 1. Directories

| | configDir | stateDir |
|---|---|---|
| `MC_HOME` set (tests, portable) | `$MC_HOME/config` | `$MC_HOME/state` |
| Windows | `%APPDATA%\mission-control` | `%LOCALAPPDATA%\mission-control` |
| macOS | `~/Library/Application Support/mission-control` | same as configDir + `/state` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/mission-control` | `${XDG_STATE_HOME:-~/.local/state}/mission-control` |

Both are created on daemon start (mode 0700 on POSIX). The hook never creates
`configDir`; it creates `stateDir/spool` if missing.

## 2. Files

| File | Writer | Format |
|---|---|---|
| `configDir/config.json` | Woody (and `mc install` for nothing but `$schema`; exception: `mc install shell` sets `adapters.shell.enabled`, T051) | `config.schema.json`; absent file = all defaults |
| `stateDir/token` | daemon (first start), `mc token rotate` | 43 chars base64url, no newline; user-only permissions |
| `stateDir/browser-sessions.json` | daemon | digests of paired browser sessions (api.md 2); deleted by `mc token rotate` |
| `stateDir/daemon.json` | daemon on start, removed on clean stop | `{"pid": n, "port": n, "startedAt": iso, "version": "x.y.z"}` |
| `stateDir/sessions.json` | daemon | `{"version": 1, "callsignCounter": n, "records": [{"session": Session, "target": ResolvedTarget \| null, "cursor": {"lastAppliedSentAt": n}, "origin": IngestOrigin \| null}]}` |
| `stateDir/events.jsonl` (+ `.1`) | daemon | one `{"receivedAt": ms, "envelope": IngestEnvelope}` per line; rotate at 10 MiB, keep 1 old |
| `stateDir/spool/*.json` | hook | one `IngestEnvelope` per file, name `<sentAt>-<hookPid>-<seq>.json`; max 1000 files (the hook deletes the oldest beyond that) |
| `stateDir/hook-errors.log` | hook | one line `iso<TAB>code<TAB>message`; truncated to its last 500 lines by the daemon on start |
| `stateDir/daemon.log` (+ `.1`) | daemon | pino-style JSON lines; rotate at 5 MiB |
| `stateDir/fake-platform.jsonl` | daemon with `MC_PLATFORM=fake` | one `FakeCall` per line |
| `stateDir/install-manifest.json` | `mc install` | what each installer added, so `uninstall` removes exactly that (T051) |
| `stateDir/bin/mc-hook.js`, `stateDir/bin/mc.js`, `stateDir/bin/package.json` | `mc install`, `mc start` (D-41, amended 2026-11-15) | launchers: one `import()` of the installed entry file; format in `docs/PACKAGING.md` 4. `package.json` is `{"type":"commonjs"}` |

## 3. Loading rules

- Parse with `JSON.parse`; comments are not allowed.
- Validate with Ajv (`allErrors: true, useDefaults: true, strict: false`; strict mode rejects
  `default` beside `oneOf`, which `quietHours` uses) against
  `config.schema.json`; `formats` from `ajv-formats`.
- Invalid at start: exit 2 with `config invalid: <instancePath> <message>` (one line per
  error). Invalid on hot reload: keep the old config, set
  `DaemonInfo.configOk = false`, `configError` = the first error line.
- Hot reload: `fs.watch` on `configDir` (not the file; editors replace files),
  debounced 300 ms. `port` changes require a restart; the daemon logs a warning and
  keeps the old port.
- `ui.*` is reserved: validated, but not read by the daemon or exposed to the page in v1
  (the page follows `prefers-reduced-motion` and uses the `console` theme).
- Environment overrides (tests only): `MC_HOME`, `MC_PLATFORM=fake`, `MC_TEST=1`,
  `MC_PORT` (overrides `port`; `0` = ephemeral, written to `daemon.json`). The Copilot home the
  daemon reads session logs from is `COPILOT_HOME`, else `$MC_HOME/copilot` when `MC_HOME` is set,
  else `~/.copilot` (D-56; so a test daemon never reads the real one).
