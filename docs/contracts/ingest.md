# Contract: ingestion (hooks and adapters to the daemon)

Status: FROZEN at plan freeze. Schema: `ingest.schema.json`. Fixtures:
`packages/contracts/fixtures/ingest/*.json` (T002 creates them from section 7).

## 1. Transport

```
POST http://127.0.0.1:<port>/ingest/v1/events
Authorization: Bearer <token>            # contents of <stateDir>/token, trimmed
Content-Type: application/json
Body: IngestEnvelope (ingest.schema.json), max 16 KiB
```

| Response | Meaning | Hook action |
|---|---|---|
| `202 {"accepted": true, "sessionId": "claude-code:abc"}` | applied or recorded | exit 0 |
| `400 {"error": {"code": "invalid_envelope", "message": "..."}}` | schema failure | exit 0, do not spool, append one line to `<stateDir>/hook-errors.log` |
| `401` / `403` | token wrong | exit 0, spool (the token may be rotated by the next daemon start) |
| network error, timeout (800 ms), 5xx | daemon down or hung | exit 0, spool |

Port: from `<stateDir>/daemon.json` `port` (the running daemon), else
`<configDir>/config.json` `port`, else 47800. Paths per `config.md` section 1.

## 2. Environment allowlist

`mc-hook` copies only the variables listed in `ingest.schema.json`
`$defs.Origin.properties.env.properties`, truncating values to 256 characters.
`SSH_CONNECTION` is replaced by the literal string `present`. Nothing else from the
environment is read into the envelope. The daemon rejects envelopes with other keys.

## 3. Process fingerprint

- `hookPid`: `process.pid`.
- `sentAt` (envelope): `Math.floor(performance.timeOrigin)`, the epoch ms at which the
  hook process started. Never `Date.now()` at send time (`attention.md` 3 explains why).
- `ancestry`: walk parents from `process.ppid`, nearest first, max 16, stop at PID 0/1,
  `System`, `launchd`, `systemd` (the stop process itself is not included). Each entry
  `{pid, name, startTime}`. Implementations per OS in
  `packages/platform/src/process/` (T013): Windows `CreateToolhelp32Snapshot` +
  `GetProcessTimes` via koffi; Linux `/proc/<pid>/stat`; macOS one call to
  `ps -A -o pid=,ppid=,lstart=,comm=` parsed once.
- `agent`: the nearest ancestry entry matching the adapter's agent rule. Claude Code
  runs the hook in exec form (`claude-hooks.md` 1: no shell in between), so for
  `claude-code` the hook's direct parent `ancestry[0]` is the agent process. No rule
  reads another process's command line (on Windows that needs a WMI/CIM query of
  0.5-1.5 s, which would break the hook's budget).

| Adapter | Agent rule (case-insensitive on `name`, after stripping `.exe`) |
|---|---|
| claude-code | the nearest entry named `claude`; else `ancestry[0]` if it is named `node` or `bun` (npm-installed Claude Code) |
| codex | the nearest entry named `codex`; else `ancestry[0]` if named `node` |
| copilot-cli | the nearest entry named `copilot` (D-36) |
| shell | the hook's direct parent (the shell itself) |

  If none matches, `agent` is `null` (liveness then falls back to `lostAfterHours`).
- `tty` (POSIX): `ps -o tty= -p <agent.pid>` prefixed with `/dev/` (`??` -> null).
- `console` (Windows): `GetConsoleWindow()` from the hook process as `consoleHwnd`.
  If it returns 0 (Claude Code may spawn hooks with `CREATE_NO_WINDOW`, which leaves
  the hook without a console) and `agent` is non-null: `FreeConsole()`,
  `AttachConsole(agent.pid)`, `GetConsoleWindow()`, then `FreeConsole()` again (all
  kernel32, declared locally with koffi; any failure leaves the field null).
  `GetAncestor(consoleHwnd, GA_ROOTOWNER)` as `ownerHwnd` (Windows Terminal and VS Code
  set the pseudoconsole window's owner to the terminal window). Both null when no
  console can be found. Format `0x` + 16 uppercase hex digits. Which of the two paths
  produced the value is unknowable to the daemon and does not matter; T020's checkpoint
  records which one fires on dev-pc.

## 4. Payload allowlist (Claude Code)

`mc-hook claude-code` reads the hook JSON from stdin (max 1 MiB; larger: read and
discard, send with payload `{}`). It sets `nativeSessionId = session_id`,
`event = hook_event_name`, then copies only these fields:

| Event | Fields copied into `payload` | Truncation |
|---|---|---|
| all | `cwd`, `permission_mode` | cwd 1024 |
| SessionStart | `source`, `model` | |
| UserPromptSubmit | `prompt` (only if `capturePromptText`) | 200 chars |
| PermissionRequest | `tool_name` | |
| PostToolUse, PostToolUseFailure, PreToolUse | `tool_name` (+ `error` for Failure, 200) | |
| Notification | `message`, `title`, `notification_type` | 200 / 100 / 48 |
| Stop, SubagentStop | `last_assistant_message` (only if `capturePromptText`) | 200 |
| StopFailure | `error` = `"<error>: <error_details>"` when `error_details` is a non-empty string, else `error` (the hook input's `error` is a type code such as `rate_limit`; `error_details` is e.g. `429 Too Many Requests`) | 200 |
| SessionEnd | `reason` | |
| SubagentStart | `agent_type` | |

Never copied: `tool_input`, `tool_response`, `tool_use_id`, `transcript_path`,
`permission_suggestions`, `scratchpad_dir`, anything else. Truncation is by Unicode
code points, appending nothing. `capturePromptText` is read from `config.json`
`sessions.capturePromptText` (default true).

Unknown `hook_event_name`: send with payload `{cwd, permission_mode}` only.
Malformed JSON on stdin: exit 0, nothing sent, one line to `hook-errors.log`.

## 5. Host classification (pure, `packages/core/src/classify.ts`)

Input: `origin`. Output: `{kind, app, display, multiplexer}` (`Host` in
`session.schema.json`, plus `os` copied from origin). Rules are applied in order;
the first match sets `kind`. `names(ancestry)` is the list of lower-cased names with
`.exe` stripped.

| # | Condition | kind | app |
|---|---|---|---|
| 1 | `env.SSH_CONNECTION` present | `remote` | null |
| 2 | `env.CLAUDE_CODE_ENTRYPOINT` is `claude-vscode`, or (ancestry contains a name in VSCODE_NAMES and no name in SHELL_NAMES between the agent and that VS Code process) | `vscode-extension` | the VS Code process name |
| 3 | `env.TERM_PROGRAM == "vscode"` or ancestry contains a name in VSCODE_NAMES | `vscode-terminal` | the VS Code process name |
| 4 | `env.WT_SESSION` set, or ancestry contains `windowsterminal`; skipped when `conhost` is nearer the agent in the ancestry than any `windowsterminal` (D-50) | `windows-terminal` | `WindowsTerminal.exe` |
| 5 | `origin.os == windows` and (`console.consoleHwnd` non-null, or `conhost` is nearer than any `windowsterminal`) | `conhost` | `conhost.exe` |
| 6 | `env.TERM_PROGRAM == "Apple_Terminal"` | `macos-terminal` | `Terminal` |
| 7 | `env.TERM_PROGRAM == "iTerm.app"` or `env.ITERM_SESSION_ID` set | `iterm2` | `iTerm2` |
| 8 | `env.WEZTERM_PANE` set | `wezterm` | `wezterm-gui` |
| 9 | `env.KITTY_WINDOW_ID` set | `kitty` | `kitty` |
| 10 | `origin.os == linux` and ancestry contains a name in LINUX_TERMINALS | `linux-terminal` | that name |
| 11 | otherwise | `unknown` | null |

- VSCODE_NAMES: `code`, `code - insiders`, `code-insiders`, `codium`, `cursor`, `code helper`, `code helper (plugin)`, `electron` (only when its parent is one of the others).
- SHELL_NAMES: `bash`, `zsh`, `fish`, `sh`, `dash`, `pwsh`, `powershell`, `cmd`, `nu`, `tcsh`, `ksh`.
- LINUX_TERMINALS: `gnome-terminal-server`, `konsole`, `xfce4-terminal`, `alacritty`, `foot`, `xterm`, `urxvt`, `terminator`, `tilix`, `ghostty`, `ptyxis`, `kgx`, `lxterminal`, `mate-terminal`, `qterminal`, `st`.
- `multiplexer`: `{kind: "tmux", pane: env.TMUX_PANE}` when `env.TMUX` and `env.TMUX_PANE` are set (independent of `kind`; when tmux is set, rules 10 and 11 look for the terminal of the most recently active tmux client instead, `linux.md` 4.3, which the platform layer resolves, so core leaves `kind` as computed).
- `display`: windows -> `win32`; macos -> `cocoa`; linux -> `wayland` if `env.WAYLAND_DISPLAY` set, else `x11` if `env.DISPLAY` set, else null.

## 6. Other adapters

### 6.1 Codex CLI

`mc install codex` sets `notify = ["<node>", "<repo>/packages/hook/dist/mc-hook.js", "codex"]`
in `~/.codex/config.toml` (backing up the file). Codex allows one `notify` program, so
if a top-level `notify` string array already exists (D-37) install wraps it: the original
argv is saved in the install manifest (with the original lines) and the new line is
`notify = ["<node>", "<hook>", "codex", "--chain", "<base64url(JSON array of the original argv)>"]`.
Codex appends its JSON argument last, so the hook reads the final argument as the payload.
`mc uninstall codex` puts the original lines back byte for byte. A `notify` that is not a
plain string array (or is a multi-line string) is left alone: exit 1 with a manual-merge
instruction. Installing again over an mc line changes nothing.
Codex invokes the program with one JSON argument (not stdin). `mc-hook codex [--chain <b64>] <json>`
parses the last argument:

| Codex field | Envelope |
|---|---|
| `type` (`agent-turn-complete`) | `event` |
| `thread-id` (or `turn-id` if absent) | `nativeSessionId` (non-matching chars replaced by `_`) |
| `cwd` | `payload.cwd` |
| `last-assistant-message` | `payload.last_assistant_message` (if capturePromptText) |
| `input-messages[0]` | `payload.prompt` (if capturePromptText) |

Chaining: when `--chain` is present the hook starts the original program first, with the
same single JSON argument, detached, no shell, output ignored, never waited on; a chain
that is malformed or cannot start is logged to `hook-errors.log` and never fails the hook.

Internal threads: Codex also notifies for its own title-generation thread. The payload has
no field that marks it (only the fields above), so the rule is on `input-messages[0]`:
if it starts (after leading whitespace) with `Generate a concise, single-line task title`
the hook posts nothing (still chains it). The rule applies regardless of `capturePromptText`.

Codex gives no start or end events; its cards are created on the first turn completion
and liveness relies on `agent` PID (rule `codex`). Field names verified against Codex
docs at build time by T053; if they differ, T053 stops with a CR.

### 6.2 Shell integration

`mc-hook shell <Event> [--exit <code>] [--duration-ms <n>] [--command <word>]`, called
from the prompt hook the installer adds. `nativeSessionId = <shellPid>-<shellStartTime>`
(hashed to `[A-Za-z0-9]` 16 chars). Events: `ShellStart`, `ShellPrompt`,
`ShellCommandStart`, `ShellCommandEnd`, `ShellExit`. Snippets in `T053`.

### 6.3 Copilot CLI (D-36)

`mc install copilot` writes `<COPILOT_HOME or ~/.copilot>/hooks/mission-control.json` (Copilot loads
`hooks/*.json` from its user directory; docs.github.com `hooks-configuration`), one entry per event:
`{"type":"command","exec":"<node>","args":["<repo>/packages/hook/dist/mc-hook.js","copilot-cli","<Event>"],"timeoutSec":5}`
(SessionEnd 2). Events: SessionStart, UserPromptSubmit, PermissionRequest, Notification, PostToolUse,
PostToolUseFailure, Stop, SessionEnd. PascalCase names make Copilot send snake_case payloads. The hook
reads JSON from stdin; the event name is `argv[3]` (camelCase names also accepted), the session id is
`session_id` or `sessionId`. Same allowlist as section 4 (`tool_input`, `tool_result`, `transcript_path`,
`initial_prompt` never copied; `cwd` or `workingDirectory` for cwd). The hook prints nothing and exits 0,
so Copilot's own permission flow is untouched. Envelope events are the Claude Code names; value mappings:
SessionStart `source: new` -> `startup`; Notification `notification_type: agent_idle` -> `idle_prompt`.
Agent PID: rule `copilot` in section 3.
SessionEnd `reason` (Copilot's values) onto the `endReason` enum (attention.md SM-20; the enum is frozen, so
nothing new is added): `user_exit` -> `prompt_input_exit`; `complete`, `error`, `abort`, `timeout` -> `other`
(the enum has no value for them; the raw reason stays in `lastEvent.summary` as `Session end (<reason>)`);
any other reason -> `other`. The reducer applies this mapping, not the hook, so the payload keeps the raw reason.
SessionEnd sets `process.alive = false` for every adapter (SM-20, D-38).
`mc install copilot` records the `mission-control.json.mc-backup-*` files it made and whether it created the
hooks directory; `mc uninstall copilot` deletes exactly those backups and that directory when it is empty.

### 6.4 Generic and others

`adapter: "generic"` is reserved. A generic adapter may POST envelopes with events `Start`, `Working`,
`NeedsInput`, `NeedsPermission`, `Done`, `Error`, `End` (mapped in `attention.md` table 3).

## 7. Fixtures (T002 writes these exact files)

`packages/contracts/fixtures/ingest/`:
`cc-session-start.json`, `cc-user-prompt.json`, `cc-permission-request.json`,
`cc-notification-permission.json`, `cc-notification-idle.json`,
`cc-notification-auth.json`, `cc-post-tool.json`, `cc-stop.json`,
`cc-stop-failure.json`, `cc-session-end.json`, `codex-turn-complete.json`,
`shell-command-end.json`, and the invalid set `invalid-extra-env.json` (has
`env.HOME`), `invalid-tool-input.json` (has `payload.tool_input`),
`invalid-version.json` (`v: 2`). Each valid fixture uses `nativeSessionId`
`fixture-1` and `origin.os` `windows` with a Windows Terminal ancestry
(`claude.exe` <- `pwsh.exe` <- `WindowsTerminal.exe`), except where the name says
otherwise. Raw Claude Code hook inputs (pre-hook) live alongside as
`raw/cc-*.json` for the hook tests, copied from the examples in
`code.claude.com/docs/en/hooks` (SessionStart, UserPromptSubmit, Notification,
PermissionRequest shapes, read 2026-11-08) with a `tool_input` added to
PermissionRequest so HK-05 can prove it is dropped.
