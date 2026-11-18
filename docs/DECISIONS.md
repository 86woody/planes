# Decisions

Format: `D-nn | date | decision | alternatives considered | why`. After plan freeze, a
change to any `docs/contracts/` file needs a new D-nn titled `D-nn: Amends <file>`.

## D-01 Stack: Node + TypeScript, pnpm monorepo, run from a clone (2026-11-08)

- **Chosen:** Node >= 22, TypeScript strict, pnpm workspaces; daemon, hook, CLI, UI and
  VS Code extension all TypeScript. One language across every part, including the VS
  Code extension, which must be TypeScript/JavaScript anyway.
- **Alternatives:** Rust single binary (tauri-style, as schmux): best footprint and
  native APIs, but three OS windowing stacks in Rust are a large surface for Haiku
  builders, and the VS Code extension would still be TS. Go single binary: good
  cross-compile, weak Win32/AppKit ergonomics, no shared types with the UI. Python:
  packaging pain on Windows.
- **Why:** Woody's harness tools are TypeScript/pnpm (blackbox); JSON Schemas generate
  TS types used by daemon, hook, UI and extension alike, so contracts are enforced by
  the compiler. Packaging into a single executable (Node SEA) is deferred, not ruled
  out; nothing in the design depends on running from a clone except install paths.
- **Cost accepted:** `mc-hook` pays Node start-up (~60-120 ms) per event. It runs as an
  async hook, so Claude Code never waits (D-03).

## D-02 Native OS access: koffi FFI on Windows, OS tools on macOS and Linux (2026-11-08)

- **Chosen:** Windows: `koffi` (prebuilt FFI, no compiler) calling `user32`/`kernel32`
  in process, plus Windows PowerShell 5.1 for UI Automation (tab selection) and WinRT
  toasts. macOS: `osascript` (AppleScript and JXA) child processes;
  `terminal-notifier` when present. Linux: `wmctrl`/`xdotool` on X11, compositor IPC
  (`swaymsg`, `hyprctl`, KWin D-Bus scripting, a GNOME extension's D-Bus) on Wayland,
  `dbus-next` for notifications.
- **Alternatives:** node-gyp native addons (needs a C++ toolchain on every machine; Haiku
  builders would fight build errors); PowerShell for every Win32 call (300-600 ms per
  spawn, too slow for discovery); a Swift helper app on macOS (best API access, but
  signing and bundling are out of scope for v1, revisit for notification clicks).
- **Why:** no compiler needed anywhere; every call is testable behind the
  `PlatformAdapter` interface with a fake.

## D-03 Claude Code ingestion: async command hook, not HTTP hook (2026-11-08)

- **Chosen:** a `command` hook in exec form (`command` = node, `args` = [mc-hook.js,
  `claude-code`], no shell; `claude-hooks.md` 1) with `"async": true`
  (except `SessionEnd`, synchronous with `timeout: 2`, because async hooks may be
  killed at exit).
- **Alternatives:** Claude Code `http` hooks POST the event JSON directly to the daemon
  (no Node start-up), but they carry no process identity: no PID, no TTY, no terminal
  environment, so the daemon cannot find the window. A hybrid (HTTP for most, command
  for SessionStart) was considered; rejected because PIDs can change on `--resume` and
  a fingerprint on every event keeps the binding fresh.
- **Why:** window discovery needs the process ancestry and the terminal environment
  variables that only a child process of the agent can see.
- **Consequence:** async hooks can arrive out of order. Each envelope carries `sentAt`
  (ms) and a per-process `seq`; the reducer ignores state transitions from envelopes
  older than the last applied one (`docs/contracts/attention.md` 3).

## D-04 UI: a web page served by the daemon (2026-11-08)

- **Chosen:** React 19 + Vite static build served by the daemon at `/`.
- **Alternatives:** Electron or Tauri app (the ask says "on a browser"; also another
  window to manage); server-rendered HTML with no framework (fine for v1, but card
  state transitions and WebSocket patches are simpler with React; Woody's blackbox
  console is React 19 + Vite).

## D-05 Browser auth: a typed pairing code, then a persisted cookie (2026-11-08, revised in review round 1)

- **Chosen:** `mc open` asks the daemon (bearer-authenticated) for a pairing code
  (8 Crockford base32 characters shown as `XXXX-XXXX`, one live code at a time, single
  use, 60 s TTL, dead after 5 wrong attempts), prints it, copies it to the clipboard,
  and opens `http://127.0.0.1:<port>/` with **no code in the URL**. The page's PAIRING
  REQUIRED banner takes the code; `POST /api/pair` returns an `HttpOnly; SameSite=Strict;
  Path=/` cookie plus a CSRF token. Browser sessions persist as digests across daemon
  restarts for 30 days idle (api.md 2), so pairing happens once per browser per month,
  not per reboot.
- **Alternatives:**
  - *Single-use code in the URL fragment* (`/#pair=<code>`, then `history.replaceState`).
    Zero typing; fragments are never sent to a server or in a `Referer`. **Rejected by
    default** because the workspace rule says "Never: a token in a URL", and only Woody can
    waive his rule (PRD Q1). If he waives it, the change is small and contained: T050 step
    6 opens `/#pair=<code>`, T032 step 2 exchanges and strips the fragment, T033
    `openPaired` uses the URL; api.md and the code format stay as they are.
  - No auth: any local process, or any web page via DNS rebinding, could focus windows.
  - A long token in the query string: lands in history and server logs.
- **Why:** complies with the workspace rule as written; persistence (round 1, F3) makes
  the typing rare; 40 bits of code entropy with 5 attempts and 60 s is ample on loopback.
## D-06 Notifications per OS (2026-11-08)

- **Chosen:** Windows: WinRT toast XML through Windows PowerShell 5.1 with a registered
  AppUserModelID (`HKCU\Software\Classes\AppUserModelId\WoodyDeus.MissionControl`) and
  `activationType="protocol"` launching `mission-control://restore/<sessionId>`.
  macOS: `alerter` (click reported in-process) or `terminal-notifier -execute 'mc restore ...'`
  when installed, otherwise `osascript display notification` (no click action);
  exact order in `docs/platforms/macos.md` 4. Linux:
  `org.freedesktop.Notifications.Notify` over D-Bus with a `default` action and an
  `ActionInvoked` signal handler.
- **Alternatives:** `node-notifier` (bundles SnoreToast and an old terminal-notifier;
  unmaintained); browser Web Notifications only (needs the tab open; kept as a
  secondary channel, see `docs/contracts/api.md` 5).
- **Why:** each is the OS-native path; protocol activation on Windows survives the
  toast moving to the Action Center and does not need the daemon to own a window.

## D-07 VS Code: a small bridge extension (2026-11-08)

- **Chosen:** `mission-control-bridge`, a VS Code extension that connects to the daemon,
  reports its window's workspace and terminals (with shell PIDs), and executes
  `terminal.show()` on request.
- **Alternatives:** `code --reuse-window <folder>` alone (raises a window but cannot
  select a terminal and may open a new window); a `vscode://` URI handler alone (same
  limits, plus a browser prompt). Kept as fallbacks.
- **Why:** only code running inside VS Code can map a shell PID to a terminal tab and
  select it.

## D-08 Binding a VS Code bridge to an OS window: focus-event capture, title fallback (2026-11-08)

- **Chosen:** when a bridge reports `windowState {focused: true}`, the daemon reads the
  OS foreground window; if it belongs to a VS Code process it binds the bridge's
  `windowId` to that native handle. Fallback: match top-level VS Code windows whose
  title contains the bridge's `workspaceName`.
- **Alternatives:** asking the extension for its native handle (no API); per-window
  unique titles via `window.title` setting (writes to user or workspace settings).
- **Why:** zero configuration and no file writes; a window is bound the first time
  Woody clicks into it, which happens within seconds of opening.

## D-09 "Maximize" means OS maximize, not full screen (2026-11-08)

Windows `SW_MAXIMIZE`; macOS window zoom (`AXZoomButton` press or AppleScript `zoomed`),
not native full screen, which moves the window to its own Space and hides the
mission-control browser; Linux `_NET_WM_STATE_MAXIMIZED_VERT|HORZ`. Config
`restore.maximize` can be `always` (default, the ask), `if-minimized`, or `never`.

## D-10 Wayland: per-compositor backends, explicit `none` (2026-11-08)

Wayland gives clients no protocol to focus another client's window. Backends: sway
(`swaymsg`), Hyprland (`hyprctl`), KDE Plasma 6 (KWin scripting over D-Bus), GNOME
(requires the "Window Calls" extension's D-Bus interface, or ours if that is
unavailable, Q-L1 in linux.md). Anything else: capability `none`, the card says why,
RESTORE copies the session's `cwd` and shows "FOCUS MANUALLY". Alternatives: XWayland
tricks (only work for XWayland windows; used as a sub-case where applicable).

## D-11 Hook spool when the daemon is down (2026-11-08)

`mc-hook` never starts the daemon. If the POST fails it writes the envelope to
`<stateDir>/spool/<sentAt>-<pid>-<seq>.json` (max 1000 files, oldest dropped). The
daemon ingests and deletes the spool on start. Alternative: auto-start the daemon from
the hook (surprising side effect, slow first event, races when ten hooks fire at once).

## D-12 Never capture tool input (2026-11-08)

The hook forwards an allowlist of payload fields per event; `tool_input`,
`tool_response` and `permission_suggestions` are dropped (they carry file contents,
commands and secrets). Prompt and assistant text are truncated to 200 characters and
can be turned off (`sessions.capturePromptText`).

## D-13 One fixed, configurable port: 47800 (2026-11-08)

Hooks, the extension and the CLI read the port from `config.json`; the daemon also
writes `<stateDir>/daemon.json` `{pid, port, startedAt, version}`. If the port is
busy, the daemon exits 2 with the holder's PID if known. Alternative: port hopping
(hooks would need to read `daemon.json` on every event; kept as the read path anyway,
so changing the port in config is enough).

## D-14 Persistence: JSON snapshot + JSONL event log, no database (2026-11-08)

`sessions.json` (atomic write, debounced 500 ms) and `events.jsonl` (rotated at 10 MB,
2 files kept). Alternative: SQLite (`node:sqlite` is still flagged experimental in Node
22; a native module would violate D-02). Data volume is tiny.

## D-15 Config: JSON validated by JSON Schema, hot-reloaded (2026-11-08)

`config.json` with `$schema`, validated by Ajv against
`docs/contracts/config.schema.json`; invalid edits are rejected with the previous
config kept and an error shown in the page. Alternative: TOML (one more parser and no
schema validation in editors).

## D-16 Acknowledge semantics (2026-11-08)

ACK (button, or a successful RESTORE when `restore.ackOnRestore`) marks the current
attention acknowledged: the card stops blinking and no re-notification is sent, but
the state stays (`needs_permission` stays red) until the agent's next event changes
it. Alternative: ACK clears the state (lies about the agent: it is still waiting).

## D-17 Remote and SSH sessions are shown, never restored (2026-11-08)

If `SSH_CONNECTION` is set in the hook's environment, the session is `host.kind =
remote` with restore capability `none`. A hook can only reach the daemon on its own
machine; a session on a remote machine whose hook runs remotely is invisible here.

## D-18 Plain shells: opt-in shell integration only (2026-11-08)

Shells are not enumerated by scanning every process (noisy, and a shell has no
"attention"). `mc install shell --pwsh|--bash|--zsh` adds a prompt hook that sends
`ShellPrompt` (idle) and `ShellCommandStart` (working) events and a `ShellCommandEnd`
with exit code; long commands (> `adapters.shell.notifyAfterSeconds`, default 60)
finishing raise `done` attention. Default off.

## D-19 E2E runs the real daemon with a fake platform (2026-11-08)

Playwright drives the real daemon started with `MC_PLATFORM=fake`, which records
focus and notify calls to `<stateDir>/fake-platform.jsonl` and exposes them at
`GET /api/test/fake-platform` only when `MC_TEST=1`. Real OS behaviour is proven by
`packages/platform/test/os/*.os.test.ts` (guarded by `MC_OS_TESTS=1`) and the manual
checklists. Alternative: a separate mock daemon (two implementations to keep in sync).

## D-20 Sessions are keyed by adapter and native id (2026-11-08)

`id = "<adapter>:<nativeId>"`, e.g. `claude-code:3f2a...`. A `SessionStart` with
`source: resume` for a known id reactivates the card (state from `ended` back to
`idle`); an unknown id creates a card. Callsigns `MC-01`, `MC-02`, ... are assigned in
creation order, reused after 99, and never shown for two live cards at once.

## D-21 DRAFT (rev 3): Answer from the notification (agent questions first, permissions opt-in) (2026-11-11)

Status: **draft, not accepted.** Revision 3 answers review round 4 (`docs/review/round-4.md`,
`round-4-response.md`). No M6 task is written until spikes S1b and S2b below pass and a
round 5 returns no high findings. Woody's calls (2026-11-11): ships **inside v1 as
milestone M6**, after M5; D-12 amended as **memory only**; Other is **page-only on every OS**
(Linux and macOS lack a text field; Windows spike S2 could not read one).

**Ask.** A notification carries a button per choice the agent offered, plus an Other field
where Woody types a free-text answer.

**Hook facts (Claude Code hooks reference, checked 2026-11-11).**
- `Notification` has `message`, optional `title`, `notification_type`; no options; cannot
  block or answer.
- `PermissionRequest` input: `tool_name`, `tool_input`, `permission_suggestions`. It can block
  and return `hookSpecificOutput.decision`: `behavior` allow or deny, `updatedInput` (allow
  only), `message` and `interrupt` (deny only). Exit 2 is ignored. Matching hooks run in
  parallel. Default command-hook timeout 600 s. A hook `onFailure: "block"` denies.
- `AskUserQuestion` `tool_input.questions[]` is `{question, header, options[{label,
  description}], multiSelect}`; answering needs `updatedInput` with the questions plus
  `answers` (question text to label).

**What the probe files show (dev-pc, Windows 11 build 26300; `claude --version` printed
2.1.322 in the author's shell, not recorded in a probe file).** Every claim below is limited
to what `probe/*.jsonl` contain; where the evidence is Woody's report, it says so.
1. AskUserQuestion, all runs two questions, mostly auto mode: `PreToolUse` then
   `PermissionRequest` (about 90 ms later) carry the full `questions[]`. `PermissionRequest`
   has **no `tool_use_id`**; for this tool no `permission_suggestions`.
2. A hook answer with free text that is not a listed option was accepted in **2** runs
   (`answer-events.jsonl` pids 29200 and 30148; `PostToolUse` follows by about 90 ms). In a
   third run (pid 30692) the terminal answered first and the hook's later answer was ignored.
3. `annotations: {}` appears on **every** terminal answer (Red, No, and typed Other), so it
   does not mark Other. A typed Other arrives as a plain string in `answers`.
4. One held-hook run lasted 6.6 s before the terminal answered and produced **no**
   `Notification`; the runs that produced `permission_prompt` (about 6 s after the prompt)
   had no hold. Whether a held sync hook suppresses it is unknown.
5. S1, default mode, Bash: `s1-events.jsonl` shows the hook returned allow, deny+message and
   deny+interrupt for three successive commands; `events.jsonl` shows `PostToolUse` after the
   first and no `PostToolUse` or `PostToolUseFailure` after the others. That the denied
   command did not run, that the message reached the model verbatim, and what the model did
   after `interrupt` are Woody's observations, not log content.
6. `prompt_id` is shared by all calls of one prompt. `PostToolUse` carries `tool_input`.
7. S2: `s2-events.jsonl` has `shown` lines and no `Activated`, `Dismissed` or `Failed` line.
   It proves the handlers logged nothing; it does not record that anyone clicked, and the
   failed `Register-ObjectEvent` and compiled-sink attempts are not in any file.
Unverified: AskUserQuestion in default mode, a single-question call, a deny made in the
terminal, parallel tool calls, a 600 s hold, multi-select output, other versions or OSes.

**Decision (proposed).**
1. **Scope and hooks.** The async `PermissionRequest` hook of D-03 stays exactly as it is
   (it still feeds SM-11 and keeps AC-11 and HK-01..10 true). When `answers.enabled`, the
   installer adds a second, synchronous hook `mc-hook answer`, matcher `answers.holdTools`
   (default `["AskUserQuestion"]`, so Bash and other prompts are untouched until S1b shows
   the terminal stays usable during a Bash hold). It posts **only** to
   `/ingest/v1/requests`, never to `/ingest/v1/events` and never to `spool/`, so SM-11 fires
   once. No `onFailure`. `answers.holdSeconds` default 30 (raise after the 600 s probe);
   hook `timeout = holdSeconds + 10`. Toggling `answers.enabled` re-runs install.
2. **Identity and clearing.** The daemon mints `requestId`. `PermissionRequest` has no
   `tool_use_id`. A request is matched to a later `PostToolUse` or `PostToolUseFailure` by
   `session_id + tool_name + sha256(canonical tool_input)` (the Post events carry
   `tool_input`), never by `tool_name` alone and never by `prompt_id`. `PreToolUse` is **not**
   used (the installer does not subscribe to it). A request is cleared by: its own answer, a
   matching Post event, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, the session
   becoming `ended` or `lost`, hook exit, or `holdSeconds`. A tool denied in the terminal
   emits no Post event (S1 shows this for hook denials), so such a request stays until one of
   the others; the bound is `holdSeconds`. A `Notification` `permission_prompt` within 15 s
   of an open request is a no-op.
3. **Held-request protocol.** The hook opens one HTTP request (Node `http`) to
   `/ingest/v1/requests` and reads chunked NDJSON frames: `{"t":"hb"}` every 5 s,
   `{"t":"answer",...}`, `{"t":"cancel"}`. **It writes to stdout only after an `answer`
   frame.** It exits 0 with no stdout on `cancel`, socket close, 15 s without a frame, or
   `holdSeconds`, so the terminal prompt stays the fallback. Whenever the daemon clears a
   request it sends `cancel` and closes, so a lingering hook never answers a request that is
   gone or frees its slot late. At most 8 concurrent holds; beyond that the hook exits 0 at
   once, no request exists, and the card stays an ordinary `needs_permission` (plain toast).
   A duplicate key (`session_id + tool_name + sha256(tool_input)`) with an open request
   cancels the old request and opens a new one. A daemon restart loses the map; hooks see the
   close and exit 0; daemon start withdraws every mission-control toast.
4. **Answer routes.** Both daemon-built: the client never sends `updatedInput`, `behavior`
   or `interrupt`.
   - `POST /api/requests/:id/answer`, **browser realm only** (cookie + CSRF + Host and
     Origin checks, AC-10; bearer rejected). Body `{choice: <int>, text?}` for a question
     request, `{decision: "allow"|"deny", text?}` for a permission request, validated
     against the stored request kind. `text` up to 500 characters.
   - `POST /api/requests/:id/answer-toast`, **bearer realm**, body `{choice: <int>}` or
     `{decision}` only (no `text`). It requires a per-toast random nonce (128 bits) that
     exists only in the daemon's pending map and in the toast's own URI
     `mission-control://answer/<requestId>/<nonce>/<n>`, never in state, logs or the page.
     `mc answer <uri>` (launched by `restore.vbs` on Windows) calls it. Linux and macOS
     notification callbacks run inside the daemon and call the same answer function directly.
   Both: single use, expire at `holdSeconds - 5`, rate limit per browser session or per
   token, `410` with `{resolvedBy: "terminal"|"page"|"toast"|"timeout"}` after resolution. The
   page says "sent, waiting for Claude" until a matching Post event or hook exit confirms,
   and "answered in the terminal" only if the clearing event came first. Tests SEC-16..SEC-27
   (replay, wrong request id, expired, bearer on the browser route, browser cookie on the toast
   route, missing or wrong nonce, forged Origin, body tampering, kind mismatch, rate limit,
   late answer, second click).
5. **Permissions (opt-in).** Added to `answers.holdTools` only after S1b passes. For those
   tools the toast offers DENY and OPEN; Allow exists on the page only, which shows the full
   command. Deny sets `interrupt: false` explicitly and `message` to the typed text or
   "Denied from mission control". No `updatedPermissions`, so a click never makes a
   standing rule. `answers.allowTools` (default none) may add a toast Allow for named tools.
6. **AskUserQuestion on a toast.** Only for exactly one single-select question whose
   `question` text is unique in the call, with options plus OPEN not more than the OS's
   `answerButtons`; otherwise page-only. OPEN uses a button. No Allow button. Button labels
   are the option labels, at most 24 characters, else page-only. `answers[question] = label`.
   Other is page-only everywhere and sends the typed string as the value. Multi-select is
   page-only until S1b records its format. Worked JSON examples are copied from real
   transcripts into `contracts/` after S1b.
7. **D-12 amendment (memory only, enforced).** Pending requests live only in a daemon Map.
   Nothing about a request's content enters `sessions.json`, `events.jsonl`, logs,
   diagnostics, the WebSocket broadcast or `GET /api/state`. The broadcast may carry
   `{requestId, kind}` (a random id, no content) so the page can fetch detail from
   `GET /api/requests/:id` (browser realm). **Toast text carries the tool name, the question
   header (at most 24 characters) and the option labels above, never question text or a
   command.** OS notification history keeps toast text, so labels and header are an accepted
   exposure; `answers.toastShowsLabels` (default true) set to false numbers the buttons
   "Option 1..n" instead. The toast also carries the nonce (point 4); it is single use and
   short-lived. Test: after a request resolves, a sentinel in `tool_input` or in the question
   text is absent from the state directory and logs.
8. **Delivery per OS.** The adapter reports `answerButtons` (max count) and `answerText`
   (false on all three OSes in v1). Windows: `protocol` buttons through `restore.vbs` and
   `mc answer`; S2 found no way to read a text-box reply from a PowerShell 5.1 toast host
   (`Register-ObjectEvent` refuses WinRT events; script-block handlers logged nothing in five
   runs; a compiled sink could not be attached here). Linux: D-Bus actions only when the
   server advertises them. macOS: `alerter -actions` only; without alerter, page-only. With
   no button capability the plain attention toast is sent and the request is shown on the
   page. Answer notifications are exempt from the macOS 10-process eviction.
9. **State.** `attention.pendingRequest: {requestId, kind}` is **ephemeral**: excluded from
   `sessions.json`, the event log and diagnostics, and cleared on load. Delta (applied to
   `attention.md` on acceptance, listed here so builders can plan):

   | Row | Event | Effect |
   |---|---|---|
   | SM-11 (change) | PermissionRequest ingest | `needs_permission` as today; if a request exists for the same key, set `pendingRequest` |
   | SM-12 (change) | Notification `permission_prompt` | no-op while a request is open and under 15 s old |
   | SM-new-a | PostToolUse or PostToolUseFailure whose key matches | clear `pendingRequest` |
   | SM-new-b | UserPromptSubmit, Stop, StopFailure, SessionEnd, ended, lost | clear `pendingRequest` |
   | ACK (unchanged) | ACK | never clears or resolves a request |
   | SM-09 text | PreToolUse | not subscribed; delete the mention |

10. **Gates.** `pnpm gate:m6` is automated and **fixtures-only**; it can pass with the live
    feature broken and says so in its output. It asserts the hook stdout JSON and the daemon
    state for: answer, cancel, daemon killed mid-hold (hook exits 0, no stdout), duplicate
    key, two parallel requests of the same tool with different and with equal `tool_input`,
    the sentinel grep, the installed JSON (no `onFailure`, `timeout = holdSeconds + 10`, the
    async hook unchanged), and SEC-16..SEC-27. A **manual gate `M6-live`** on the tower runs the
    real hook and daemon and records probe-style logs pasted into the checkpoint: a question
    answered from the page; from a Windows toast; a Bash deny from the page (if Bash is in
    `holdTools`); answered in the terminal while held; the daemon killed mid-hold. Each
    asserts the hook stdout JSON and whether Claude then emitted a matching Post event.
    M6 is not done until `M6-live` is recorded.
11. **Config.** `answers.enabled` default **off**, `holdSeconds` (30), `holdTools`
    (`["AskUserQuestion"]`), `allowTools` (none), `toastShowsLabels` (true).

**On acceptance, one commit rewrites:** PRD section 5 and a new AC; AC-10, AC-11 and the
SEC and HK registries (exempting `mc-hook answer`); D-03, D-06, D-11, D-12 text;
`claude-hooks.md` (the sync hook row; PreToolUse stays unused), `attention.md`, `ingest.md`,
`ingest.schema.json`, `session.schema.json`, `api.md`, `platform-adapter.md`, `config.md`;
`platforms/windows.md` 5.2 and 5.3, `linux.md`, `macos.md`.

**Spikes before accepting.**
- **S1b (default mode):** AskUserQuestion with a single question and with multi-select;
  whether the terminal dialog stays usable while a Bash PermissionRequest hook holds;
  which events follow a deny made in the terminal; two parallel same-tool calls with the
  hook holding; a 600 s hold; record `claude --version` in the probe file.
- **S2b (Windows):** click a `protocol` button from the banner and from the Action Center
  and record the launched process and the POST that results (the `restore.vbs` path was
  already uncertain, `windows.md` W-05). Also record whether V2's text box showed.
- Done: **S1** (hook allow, deny+message, deny+interrupt on Bash in default mode) and
  **S2** (negative, point 8; a first toast with `scenario="reminder"` and a system Dismiss
  button showed no buttons, cause not isolated).

**Alternatives.**
- Type the choice into the terminal (SendKeys, UI Automation, tmux). Rejected: different on
  every OS, breaks on VS Code terminals, and is the "typing into sessions" the PRD ruled out.
- `PreToolUse` for AskUserQuestion. It carries `tool_use_id`, but it would add a hook the
  installer does not have; not needed now that matching uses `tool_input`.
- Keep this in v2. The recommended fallback if S1b or S2b fail badly.

**Cost.** Sync hook package, pending-request store, two answer routes, `mc answer`, page UI,
`pendingRequest`, SEC-16..SEC-27, a manual gate and a round 5. Larger than any single
M0..M5 task.

## D-22 Amends docs/tasks/T001.md after the first builder stopped (2026-11-12)

- **Chosen:** T001 now lists `attention.md`, `ingest.md` section 5 and `README.md` under
  "Codes against" (the signatures were in the plan, not in the task's reading list); the
  contracts placeholders are `any`; unnamed-export stubs are `export {};`; `Io` lives in
  `cli/src/main.ts`; React `JSX` is imported; lint uses `args: "none"`. No contract file
  changed.
- **Alternatives:** underscore-prefixed parameter names (changes frozen signatures'
  text); `Record<string, unknown>` placeholders (still not indexable one level down).
- **Why:** the builder stopped correctly on an incomplete reading list. First CR was a
  task-file gap, second and third were genuine omissions, all resolved without touching
  `docs/contracts/`.


## D-23 Amends docs/contracts/platform-adapter.md after the T003 builder stopped (2026-11-12)

- **Chosen:** `FakeCall.method` is the union of every `PlatformAdapter` method name
  (`capabilities` .. `dispose`), matching T003 step 4 ("every method appends a FakeCall")
  and FK-02; `args` is the argument array with callbacks omitted. `NullPlatform.resolveTarget`
  returns `{window: null, inner: null, capability: "none", reason: "no_window_found"}`; the
  "why" is the `platform_unsupported` capabilities issue. No schema changed.
- **Alternatives:** record only the four methods (contradicts the task and FK-02); a new
  `platform_unsupported` RestoreReason (changes the hash-locked session schema after T002).
- **Why:** the builder stopped correctly on a contract that disagreed with its task file.
  Consumers of `FakeCall` (api.md 3, T027, T033) read it as data and are unaffected.
## D-24 Amends docs/tasks/T032.md after the builder stopped (2026-11-12)

- **Chosen:** T032 lists `session.schema.json` under "Codes against" and names the
  acknowledgement and attention-start fields (`attention.acknowledged`, `attention.since`).
  No contract changed.
- **Alternatives:** let the builder read the generated types (outside its reading list).
- **Why:** sort order, poll strip and counts all read Session fields; T031 already listed
  the schema, T032 omitted it.
## D-25 Re-export the T013 process utilities from the `@mc/platform` root (2026-11-12)

- **Chosen:** the orchestrator adds one line to `packages/platform/src/index.ts`
  re-exporting `ancestry`, `processAlive`, `processStartTime`, `commandLine`, `ttyOf` from
  `./process/index.js`, committed on `integration`.
- **Alternatives:** a deep `@mc/platform/process` export (T020 forbids it); reopening T003.
- **Why:** internal.md 5 lists these as package exports and T020 imports them from the root,
  but T003 wrote the root barrel before T013 existed and T013 does not own it. T020's
  builder stopped on the CR.
## D-26 `@mc/hook` depends on `koffi` (2026-11-12)

- **Chosen:** `packages/hook/package.json` adds `koffi` (`^2.11.0`, the range `@mc/platform`
  uses) and the lockfile is refreshed on `integration`; T020's `envelope.ts` loads it with a
  literal `import("koffi")` on Windows only.
- **Alternatives:** route the console lookup through `@mc/platform` (not in T020's contract);
  leave `origin.console` always null (breaks ingest.md 3 on Windows).
- **Why:** ingest.md 3 needs GetConsoleWindow/AttachConsole/GetAncestor via koffi, which is
  in the stack lock but was not declared for the hook package by T001. No new dependency
  enters the workspace.
## D-27 The WebSocket hub owns the wire seq (2026-11-12)

- **Chosen:** `ws.ts` keeps one wire counter for all sockets and message types; a message
  takes the next number only when it is actually sent, so upserts coalesced away use none
  and api.md 5's "previous + 1" holds. `hello.seq` and `GET /api/state` `seq` report the
  wire counter. `SessionService.seq()/nextSeq()` and `SessionChange.seq` stay as the
  service's internal change order (T021 unchanged). Amends T026 steps 4 and 6 and the
  comment on `seq()` in internal.md 1 / `internal.ts`.
- **Alternatives:** relax api.md 5 to allow gaps (breaks T032's gap-reconnect in the UI);
  move seq assignment out of T021's `commit()` (reopens a merged task and SS-01/SS-03).
- **Why:** the T026 builder stopped correctly: the service consumes a seq per upsert, so
  coalescing in the WS layer would leave gaps that make the UI reconnect.
## D-28 Amends docs/tasks/T027.md after the builder stopped (2026-11-12)

- **Chosen:** T027's reading list adds platform-adapter.md 2 and 5 and ingest.md /
  ingest.schema.json; the three daemon error classes live in and are exported from
  `main.ts`; integration tests import nothing from T026's `test/support/**`.
- **Alternatives:** amend internal.md 2 with `createPlatform` (already in
  platform-adapter.md 2, which T027 now reads).
- **Why:** step 1.4 and IT-02/05/06, BG-01 use `createPlatform`, `FakeCall` and envelopes
  whose contracts were not on the list; the builder stopped correctly.
## D-29 m1 gate runs T013's process tests; fake mode keeps real process liveness (2026-11-12)

- **Chosen:** `scripts/gates.json` gains an m1 stage `process` running
  `packages/platform/test/process.test.ts` (PR-01..PR-08 are M1 IDs but the file was only
  in the m3 `platform-unit` stage, so the m1 audit could never pass). Under
  `MC_PLATFORM=fake`, the daemon's platform answers `processAlive` as fake-scripted AND
  real liveness (T027 `main.ts`): fake mode fakes windows and notifications, not whether
  a real child process exists. Consequence for T033: envelopes must carry a live agent pid
  (e.g. the Playwright runner's own pid and start time) or no agent.
- **Alternatives:** retag PR-* as m3 (T013 is an M1 task); script `alivePids` through a
  new test route (an API change).
- **Why:** T027 raised the gate CR and needed IT-05/PS-05 (real child exits) to end sessions.
## D-30 `@mc/platform` root re-exports the Windows registry module; T051 shell and VS Code choices (2026-11-12)

- **Chosen:** `packages/platform/src/index.ts` re-exports T042's `windows/registry.ts`
  (`AUMID`, `AUMID_KEY`, `PROTOCOL`, `PROTOCOL_KEY`, `protocolCommand`, `restoreVbs`,
  `registerAumid`, `registerProtocol`, `unregisterAll`, `ProtocolOptions`); it shells out
  to reg.exe and loads no native code, so importing it on any OS is safe. The T051 shell
  installer writes a copy of the T053 snippet with `__MC_STATE_DIR__` substituted to
  `<stateDir>/shell/mc.<ext>` and the rc block sources that copy (not the repo asset).
  The VS Code extension id is `woody.vscode-bridge`.
- **Alternatives:** a `./windows/registry` subpath export (new package.json surface);
  duplicating the reg.exe argument arrays in the CLI (two writers for one registry layout).
- **Why:** T051 stopped correctly: the CLI may only import the package root.
- **Open:** `packages/vscode-bridge/package.json` `name` is `@mc/vscode-bridge`, which vsce
  rejects as an extension name; packaging needs `"name": "vscode-bridge"` (T001-owned file)
  before the extension can be built as a .vsix.
## D-31 CLI-08 expects 403 for the old token (2026-11-12)

- **Chosen:** CLI-08's title in T050.md and `scripts/test-ids.json` now says the old bearer
  token gets **403** after `mc token rotate` and a restart, matching api.md 1 (a wrong
  credential is 403; 401 is for no credential). No contract changed.
- **Why:** T050's builder followed the contract and raised the title mismatch as a CR.
- **Also accepted from T050 (checkpoint):** the CLI re-implements config.md's path rules in
  `cli/src/lib/paths.ts` (the daemon exports no paths module); `AllowSetForegroundWindow`
  loads koffi through the platform package's resolution; doctor checks config JSON syntax only.
## D-32 Amends docs/tasks/T054.md after the builder stopped (2026-11-12)

- **Chosen:** T054's reading list adds platform-adapter.md 5, config.md 1 and DESIGN.md
  2-3/7 (selectors), and the task file quotes `mc status`'s output format from T050 and
  says to execute the exec-form hook as argv, not a joined shell string.
- **Why:** the builder stopped correctly: its four listed files did not name the selectors,
  the FakeCall shape or the CLI output it asserts on.
## D-33 Build T045/T046 on Windows with only their `any` IDs; Linux OS rows unverified (2026-11-12)

- **Chosen:** like T043/T044 on a host without a Mac, T045 and T046 are built on
  dev-pc; `task:check` checks their `any` IDs (LU-*), and the Linux-only OS IDs are
  recorded unverified until a Linux run. The WSL2 run of ORCHESTRATION 2 and 7 stays the
  plan for verifying them.
- **Why:** WSL Ubuntu-26.04 lacks node, Xvfb, openbox, wmctrl, xdotool and xterm, and sudo
  needs Woody's password; meanwhile the m5 gate on Windows needs LU-01..LU-14.
## D-34 E2E-found fixes and DESIGN.md amendments (2026-11-12)

- **Chosen:** T033 found five failures; four are product defects fixed by a new
  orchestrator task T034 (`docs/tasks/T034.md`): remote hosts resolve to capability none /
  `remote_session` without asking the platform (D-17, CARD-02); `LOS: DAEMON` is timed from
  the first close and not reset by reconnect attempts (CARD-04); the card is 196px
  including its border (DS-06); ended/lost state labels use `--mc-text-dim` for contrast,
  the rail and dashed border keep `--mc-los` (AX-01). DESIGN.md 3 now says the project
  name is a data value in the label font, never uppercased (DS-07 conflict between 1 and 3);
  T033's DS-07 excludes `project`.
- **Alternatives:** scope AX-01 away from ended/lost (hides a real contrast failure);
  uppercase project names (contradicts DESIGN.md 1 "data never uppercase").
- **Why:** e2e is the first place these surfaced; each fix stays inside DESIGN.md's intent.
## D-35 Ended cards fade by colour, not opacity (2026-11-12)

- **Chosen:** DESIGN.md 4's ended row drops `opacity: .55` on the whole card; all text on an
  ended card uses `--mc-text-dim` (6.4:1 on `--mc-console`), lamps stay unlit, the rail is
  `--mc-los`. Applied in T034's `card.css`.
- **Alternatives:** keep the opacity and exempt ended cards from AX-01 (ships a 2.7:1 label);
  a lower opacity (still fails at any value that reads as faded).
- **Why:** T034's builder measured 2.7:1 for the ended label under the opacity, which breaks
  D-34's contrast fix for the same card.

## D-36 Copilot CLI adapter wired through its file-based command hooks (2026-11-12)

- **Chosen:** `mc install copilot` owns one file, `<COPILOT_HOME or ~/.copilot>/hooks/mission-control.json`
  (format `{"version": 1, "hooks": {<Event>: [{"type": "command", "exec": <node>, "args": [<mc-hook.js>,
  "copilot-cli", <Event>], "timeoutSec": n}]}}`), never Copilot's `settings.json`. Events (PascalCase,
  which makes Copilot send snake_case payloads like Claude Code): SessionStart, UserPromptSubmit,
  PermissionRequest, Notification, PostToolUse, PostToolUseFailure, Stop, SessionEnd. The event name is
  passed in argv (the payload may not carry it) and the payload arrives on stdin. `mc-hook copilot-cli`
  sends the Claude Code event names, so the reducer reuses the Claude rows (SM-39). Two value
  mappings: SessionStart `source: new` -> `startup`; Notification `agent_idle` -> `idle_prompt`.
  Agent PID rule: nearest ancestor named `copilot`. Uninstall removes only the recorded entries and
  deletes the file when nothing else is left in it, then deletes the backup files the install recorded
  and the hooks directory if the install created it and it is empty (T075, real run 2026-11-12).
  SessionEnd reasons map onto the frozen endReason enum (ingest.md 6.3).
- **Alternatives:** edit `~/.copilot/settings.json` (shared with Woody's other settings, `config.json`
  is no longer read for hooks); repo-level `.github/hooks` (per repo, not per machine).
- **Why:** sources: docs.github.com/en/copilot/reference/hooks-configuration (locations, events,
  payloads, `exec` form, exit codes) and .../how-tos/copilot-cli/customize-copilot/use-hooks (stdin),
  read 2026-11-12. A file we own makes install idempotent and uninstall exact without parsing user config.
- **Unconfirmed until a real run (T071-style proof):** stdin delivery on 1.0.83, whether the PascalCase
  payload carries `hook_event_name` (the hook does not depend on it), the `permissionRequest` payload
  fields, whether `exec` runs with `copilot` as the direct parent, and whether a hook that prints
  nothing leaves permission handling untouched.

## D-38 SessionEnd sets process.alive false for every adapter (2026-11-12)

- **Chosen:** SM-20 (SessionEnd) sets `process.alive = false`, whatever the adapter. A session that reports its own
  end has no live agent left to track. SM-25 still sets `alive = true` when a `process_exit` or `lost` session
  receives a newer event; a session ended by SessionEnd stays ended (SM-26) until a `SessionStart` with
  `source: resume` reactivates it (D-20).
- **Alternatives:** leave alive as last observed (the liveness pass skips ended sessions, so nothing corrects it,
  and an exited Copilot agent kept reporting `alive: true` in the T074 real run).
- **Why:** docs/validation/agents/copilot.md "Problems"; orchestrator decision on the T075 change request.

## D-37 Codex notify is chained, and Codex's title thread is dropped (2026-11-12)

- **Chosen:** Codex allows a single `notify`. `mc install codex` wraps an existing one
  (`--chain <base64url argv>`, original lines kept in the manifest, restored byte for byte on
  uninstall); `mc-hook codex` starts the original program detached with the same argument.
  It also drops the turn whose first input message starts "Generate a concise, single-line
  task title" (Codex's internal title thread). `POST /api/pair-code` accepts an empty body
  under any content type. See ingest.md 6.1, api.md 3.
- **Alternatives:** keep exit 1 and manual merge (blocks users who already have a notify, as
  T071 showed); filter titles in the daemon (would still create nothing useful, but the hook
  is the cheaper place).
- **Why:** found by the real Codex run in T071 (docs/validation/agents/codex.md).

## D-39 Packaging ships one esbuild-bundled npm tarball, `mission-control-desktop` (2026-11-15)

- **Chosen:** one npm package, `mission-control-desktop`, built by `scripts/package.mjs` into
  `release/`. esbuild bundles the workspace code (contracts, core, platform, daemon, cli,
  hook) into three ESM entry files, `dist/mc.js`, `dist/daemon.js` and `dist/mc-hook.js`.
  Every third-party runtime dependency stays external and is listed under `dependencies`
  with the version from the lockfile: koffi (native prebuilds for every triplet ship in
  its own tarball), dbus-next, fastify and its plugins, ws, ajv, ajv-formats. Non-JS files
  ship beside the bundle (layout in PACKAGING.md 2). The package keeps the bin names `mc`
  and `mc-hook`. It is distributed as the `npm pack` tarball, attached together with the
  `.vsix` to a release on forge (Gitea). Users install it with
  `npm i -g ./mission-control-desktop-<v>.tgz`. Nothing goes to npmjs.com or to a
  registry.
- **Alternatives:** a Node SEA single executable per OS. That means a CJS-only main, an
  extraction layer for koffi `.node` files, `.ps1` files, the icon and the UI, and an
  `<exe> <subcommand>` model in 8-10 installer files. It is about 2-3x the work, needs
  signing, and cannot be proven on macOS. It is deferred (D-45), and this bundle is its
  first step anyway. Publishing each of the 7 workspace packages needs a scope claim and
  lockstep versions, and does not fix the clone-relative paths. Publishing to npmjs.com
  or a Gitea registry was turned down by Woody on 2026-11-15 in favour of the tarball.
- **Why:** Node >= 22 is already a requirement (D-01). The installers keep their
  `process.execPath` + `.js` model, so only the path values change, not the entry
  shapes. Bundling can only shorten `mc-hook` start-up (AC-11 unaffected; PACKAGING.md 7).

## D-40 One layout module resolves every shipped file, in clone and in package mode (2026-11-15)

- **Chosen:** `packages/platform/src/layout.ts`, exported as `@mc/platform/layout`, is
  the only place that knows where the UI, the `.ps1` files, the icon, the shell
  snippets, the macOS scripts, the three entry `.js` files, the `.vsix` and the version
  live. Its interface is frozen in PACKAGING.md 3. Package mode is chosen by an esbuild
  `define` of `__MC_PACKAGE__`; without it the module is in clone mode and returns
  today's clone paths. It replaces the five divergent "N levels up" computations
  (daemon `main.ts:190`, cli `lib/paths.ts:6`, cli `installers/manifest.ts:67`,
  platform windows `notify.ts`/`focus.ts`, macOS `discover.ts`/`notify.ts`). Contracts'
  `SCHEMA_DIR` (`<dist>/../schemas`) already resolves correctly in both layouts and is
  left alone.
- **Alternatives:** an env var naming the root (one more thing to set wrongly); keeping
  per-file path code and copying assets into matching places in the package (five
  layouts to keep in sync).
- **Why:** research found every non-JS file resolved against the clone. An installed
  package would serve a 503 UI and missing toast scripts without any error.

## D-41 Hooks point at a stable launcher in `stateDir/bin`, and install repairs in place (2026-11-15)

- **Chosen:**
  1. `mc install` writes two launchers, `stateDir/bin/mc-hook.js` and `stateDir/bin/mc.js`.
     Each is a CommonJS-compatible file, `import("<file URL of the target>")`, with a
     header comment naming the target and version. Every installer records the launcher
     path where it used to record the clone path: Claude Code and Copilot `args[0]`,
     the Codex notify argv, `shell.env` `MC_HOOK_JS`, `restore.vbs`, `autostart.vbs`,
     the protocol command, `.desktop`, the plist and the systemd unit.
  2. The launcher keeps the file name `mc-hook.js`, so the contract's identification
     rule (claude-hooks.md: `args[0]` ends in `mc-hook.js`, `args[1]` is the adapter) and
     doctor's check still hold.
  3. `mc start` and `mc install` rewrite the launchers when their target is not this
     install's `layout().hookJs` / `mcJs`. Moving the package or reinstalling it into
     another npm prefix therefore heals on the next `mc start`, and `settings.json` is
     not touched again.
  4. Installers repair instead of appending. Claude Code and Copilot match hook objects
     by the identification rule, not exact equality. A match with different values is
     updated in place, and duplicate mc groups for an event are removed (the first one is
     kept). Codex rewrites an mc `notify` line in place, keeping its `--chain` argument,
     and never wraps it. Uninstall removes every object that matches the rule, not only
     the values the manifest recorded; Codex uninstall finds the mc line by the same rule
     and restores the recorded original.
  5. `command` stays `process.execPath`. A Node switch (nvm, fnm, volta) is reported by
     doctor (D-42) and fixed by rerunning `mc install <target>`.
  6. With `MC_HOME` set, `mc install claude-code` skips its automatic uri-handler step,
     so test and smoke runs never write the real HKCU keys (the T089 writer found that a
     sandboxed install would otherwise repoint the live protocol handler).
- **Alternatives:** repair only, with no launcher, so every move rewrites
  `settings.json` (Woody chose the launcher, 2026-11-15). A bare `mc-hook` on PATH does
  not work on Windows, where npm's `.cmd` shims cannot run in exec form (D-03).
- **Why:** today a moved install breaks hooks silently, and a reinstall appends a second
  set that `mc uninstall` can never remove.
- **Contract change:** config.md 1-2 gain `stateDir/bin/` (amended 2026-11-15).

## D-42 `mc doctor` reports stale hook paths (2026-11-15)

- **Chosen:** a new check, `hook-paths` (WARN, not required). It reads
  `install-manifest.json` and the live files the manifest names: settings.json, the
  Copilot hooks file, codex config.toml, `shell.env`, `restore.vbs` and the autostart
  file. For each it reports:
  - a missing `command`, launcher or launcher target;
  - a launcher target that is not this install's `layout()`;
  - more than one mc group for the same event;
  - an mc entry that does not point at a launcher (an install from before D-41).

  Fix text: `mc install <target>`. The existing `claude-hooks` check is unchanged.
- **Alternatives:** make the check required. That would fail doctor on any machine with
  an old Node path, and the hooks are async and harmless when broken.
- **Open:** claude-hooks.md says DR-06 reports "hooks installed but no event received";
  the code does not do this. This is a pre-existing gap, not in packaging scope.

## D-43 The VS Code bridge is renamed `vscode-bridge` and ships as a file, not on a marketplace (2026-11-15)

- **Chosen:** the package name becomes `vscode-bridge` (the id stays `woody.vscode-bridge`,
  D-30). The bundle is written to `dist/extension.cjs`, and `main` points at it, so
  `"type": "module"` cannot make the extension host load it as ESM. A `.vscodeignore`
  keeps only `dist/extension.cjs`, `package.json` and `README.md`.
  `vsce package --no-dependencies --allow-missing-repository --skip-license` builds
  `vscode-bridge-<v>.vsix`, which ships inside the npm package and on the forge
  release. In package mode, `mc install vscode` installs `layout().vsixPath` and runs
  no pnpm or vsce. Clone mode keeps the build flow, so IX-08 stays true.
- **Alternatives:** the Microsoft Marketplace (needs an Azure DevOps org, a publisher, a
  PAT and a public listing, and Cursor and VSCodium do not read it); Open VSX (another
  namespace and token).
- **Why:** one user, three editors, all of which install a `.vsix` file.

## D-44 No per-OS install script; versions live in the root package.json (2026-11-15)

- **Chosen:**
  1. Install is two commands on every OS: `npm i -g <tarball>`, then
     `mc install claude-code`. No `install.ps1` or `install.sh`.
  2. The version lives in the root `package.json` `version`. `scripts/version.mjs set <v>`
     copies it to all 8 package manifests, and `check` fails if any differ. Package mode
     reads it from the `__MC_PACKAGE__` define; clone mode reads the root package.json.
  3. `mc --version` prints it. The first packaged version is `1.0.0`.
  4. A release is cut by `pnpm release`, which runs `pnpm gate`, then
     `scripts/package.mjs`, then copies the root `RELEASE-NOTES.md` into `release/`. The
     orchestrator then tags `v<version>` and creates the forge release with the tarball,
     the `.vsix` and the notes attached.
  5. `RELEASE-NOTES.md` must keep an "Unverified" section that lists AC-07, the macOS rows
     of AC-09 and MO-01..MO-06 until a Mac proves them (PRD Q4), and must say which OS ran
     the fresh-machine proof.
- **Alternatives:** install scripts. They would only wrap `npm i -g` and add a file per
  OS to prove, and `mc install` is already the per-OS step. Per-package versions would
  have to be kept in sync by hand.
- **Why:** the install surface stays the same on all three OSes, and one version source
  is enough.

## D-45 Packaging scope for v1 (2026-11-15)

- **Chosen:** in scope:
  - the tarball and the `.vsix`;
  - the layout module, launchers, repair and doctor check;
  - `mc --version`, `pnpm release` and the release notes;
  - an automated package-install smoke test on Windows and Linux (the `package` gate
    stage, m5; needs npm registry access for the external dependencies);
  - a fresh-machine proof in Windows Sandbox on dev-pc (FM-01..FM-08, manual).

  Deferred:
  - SEA binaries;
  - code signing and notarization (D-02 stands);
  - auto-update;
  - npmjs.com, Homebrew and winget;
  - a VS Code marketplace listing;
  - service, launchd or systemd changes beyond the launcher path;
  - a macOS proof (no machine).

  This lifts the PRD 5 packaging non-goal for the items in scope only.
- **Why:** this is the smallest set that lets a machine with Node and no clone run
  Mission Control. Everything deferred builds on the bundle and the layout module.

## D-46 Install is three commands: `npm i -g`, `mc init`, `mc launch` (2026-11-15)

- **Chosen:** Woody's choice (2026-11-15). Amends D-44 item 1 (two commands) and the
  PACKAGING.md 5 flow.
  1. `npm i -g ./mission-control-desktop-<v>.tgz`, then `mc init`, then `mc launch`.
  2. `mc init` asks which agents to connect (multi-select) and installs every selected
     one through the existing installers: GitHub Copilot CLI (`mc install copilot`),
     Claude Code (`mc install claude-code`), Codex (`mc install codex`). Copilot is listed
     first and pre-selected, because most users are Copilot users; empty input accepts the
     pre-selection. After the agents, init runs the support installers that apply:
     `uri-handler` on Windows and Linux (skipped when `MC_HOME` is set, same rule as
     D-41.6) and `vscode` when `code`, `code-insiders` or `cursor` is on PATH. `shell` and
     `autostart` stay out of init (`mc install shell|autostart`).
  3. Non-interactive: `--agents copilot,claude-code,codex` skips the prompt. With no TTY and
     no `--agents`, init prints a usage line and exits 2 (amended by D-53: it now connects
     the default agent, Copilot). Rerunning is safe: the installers
     repair in place (D-41.4). One result line per target (installed, repaired, skipped,
     failed); exit 1 if any selected agent failed.
  4. `mc launch` is `mc start` (already idempotent) followed by `mc open`, with the exit
     codes of those two commands. `start`, `open` and `install` stay as the reference
     commands.
  5. The prompt uses `node:readline` only (no new runtime dependency, D-39 stack lock) and
     reads from injected streams so tests drive it without a terminal.
- **Alternatives:** keep `mc install <target>` per agent (five commands, and a new user
  must know the target names); a prompt library such as `@inquirer/prompts` (a new runtime
  dependency in the tarball); init installing every agent with no prompt (writes into
  config of tools the user does not run).
- **Why:** the first run is the only moment the user must decide anything, so it is one
  prompt with the common answer pre-selected. The installers, repair and launcher design
  (D-41) are unchanged; init only sequences them.

## D-47 dbus-next is bundled, so `npm i -g` never builds usocket (2026-11-15)

- **Chosen:** `scripts/package.mjs` bundles `dbus-next` (pure JavaScript) and its
  dependencies into the three entry files, instead of listing it under `dependencies`.
  `usocket` stays external and is not a dependency, so the tarball's install tree no longer
  contains it. `x11` gets the same treatment, external and never a dependency (amended
  2026-11-15 on T093's CR). dbus-next requires it lazily in an unimplemented code path, and
  does not declare it, so the clone does not have it either. Amends D-39 and PACKAGING.md 2 (externals list).
- **Alternatives:** keep dbus-next external, which makes npm install its optional `usocket`
  and run `node-gyp rebuild`. In T089's smoke run that ran for more than 4 minutes on
  Windows and timed out. Telling users to pass `--omit=optional`: one more flag that is easy
  to miss. npm `overrides`: they need a placeholder package from a registry.
- **Why:** dbus-next calls `require('usocket')` inside a try/catch for `unix:path` buses and
  falls back to `net`. That is exactly how the clone already runs, because pnpm-workspace
  sets `usocket: false`, so it is never built. Abstract-socket buses need usocket in both
  the clone and the package, so nothing regresses.


## D-48 The board becomes the Terrain deck, before m5 (2026-11-16)

- **Chosen:** Woody's choice (2026-11-16), after three rounds of concepts (the round-3
  picker, concept "3C Terrain"). Replaces DESIGN.md "the firing room" in full.
  1. **Layout.** A readiness card (one percentage, one sentence), a "Needs you" stack (at
     most three cards, then "+N more"), a hero "Fleet terrain" card, and four telemetry
     cards. Every session is reachable in a list view (key L) that replaces the grid.
  2. **Hero.** A canvas map seen at an angle, one region per **project** (not per machine:
     PRD 5 keeps one daemon per machine with no aggregation). Line-scan terrain on top;
     height around a session is its recent activity; sessions that need you are orange
     peaks with a floating pill. Draggable inside the card only: drag orbits, wheel or pinch
     zooms, shift-drag pans, double-click or the reset button eases back. A still click
     selects a session.
  3. **Two signal colours only:** green = fine, orange = needs you or over a threshold.
     Nothing else uses either. Error is orange with a stronger treatment, not a third hue.
     Adapters are mono letter badges, not colours.
  4. **Plain state words** replace the mission wording on the page, in toasts
     (`notify-policy.ts`) and in `mc status`: Starting, Working, Idle, Needs permission,
     Needs input, Error, Done, Ended, Lost. The contract's state and reason enums do not
     change.
  5. **Telemetry cards** (token rate, context used, cost today, error rate) are reserved
     and show "Not wired" until the telemetry feature lands. No contract change now.
  6. **Fonts:** Geist and Geist Mono, self-hosted from `@fontsource/geist` and
     `@fontsource/geist-mono` (OFL-1.1). They replace the Barlow Condensed and JetBrains
     Mono packages (a D-01 dependency swap; still no request to another origin, DS-10).
  7. **Themes:** dark warm graphite by default, light "bone" by `prefers-color-scheme` and
     a toggle.
  8. **Timing:** lands on `integration` before the W- checklist, which then runs on the new
     board; the m5 gate must pass on Windows and Linux again first.
- **Alternatives:** keep the firing room for m5 and ship the deck as 1.1 (keeps the
  checklist valid, but rolls out a board Woody has already replaced); regions per machine
  (needs cross-machine aggregation, a PRD 5 non-goal); round-3 concepts 3A (strip board)
  and 3B (busier flight deck).
- **Why:** Woody found the firing room hard to read at a glance and the round-2 concepts
  unpolished. 3C keeps one bold view and puts at most one idea on each card. Telemetry is
  the last feature before rollout, so its slots are designed in now.

## D-49 An elevated target window has its own restore reason, `target_elevated` (2026-11-16)

- **Chosen:** Woody's choice (2026-11-16, option A after W-10 failed). `RestoreReason` gains
  `target_elevated`. Windows discovery returns `capability: none, reason: target_elevated`
  for a window whose owning process is elevated (both the native and the WSL branch), and
  DESIGN.md 7 gives it a fix-it text. `platform_error` keeps meaning an unexpected platform
  failure, explained by `FocusResult.detail`.
- **Alternatives:** keep `platform_error` and pre-fill `restore.lastResult` with
  `failed/permission_denied/"target window is elevated"` (no contract change, but it records
  a restore that never ran); or rewrite W-10 to accept a silent `none`.
- **Why:** W-10 (2026-11-16) showed the card for an elevated session says only "None": the
  spec's detail never reached the board, because `platform_error` is explained through a
  `FocusResult` and discovery has none. A reason code is shown before Restore is pressed,
  like every other capability gap.

## D-50 A conhost nearer than Windows Terminal wins host classification; doctor reads a missing `Enabled` as on (2026-11-16)

- **Chosen:** two W- checklist findings, fixed in T103. (1) ingest.md host rule 4 is
  skipped when `conhost` sits nearer the agent than any `windowsterminal` in the ancestry,
  and rule 5 then applies: `conhost pwsh` typed inside Windows Terminal inherits
  `WT_SESSION` and has WT as an ancestor, but its window is a classic console (MC-30,
  MC-31 were labelled Windows Terminal). (2) `mc doctor` "App notifications enabled" warns
  only when the app's Notifications Settings key (per AUMID) has `Enabled = 0`; a missing
  value is the Windows default (on).
- **Alternatives:** trust only the window class at discovery time (the label comes from
  ingest, before any window lookup); for doctor, query the WinRT notifier setting (a
  PowerShell 5.1 round trip on every `mc doctor`).
- **Why:** both were wrong for a real user on dev-pc (2026-11-16): the board said
  "Windows Terminal" for a console window, and doctor warned while toasts were on.

## D-51 The terrain shows live sessions and fits its regions; the empty note says `mc init` (2026-11-16)

- **Chosen:** after the board walkthrough on dev-pc (2026-11-16), Woody asked to address
  what it found. (1) Ended sessions leave the map, and projects with only ended sessions
  leave the region grid; the list keeps them under "Ended and lost", and J/K walks them only
  in the list. Lost sessions stay on the map (they are live and not fine). (2) The overview
  camera distance grows with the regions' extent (800 frames the 2x2 layout; more regions
  pull back, up to the 1400 limit), so no plate or label runs off the card. (3) The empty
  note gives `mc init` (`pnpm mc init` from a clone, D-46), and says "No live sessions" with
  the ended count when only ended sessions remain.
- **Alternatives:** keep ended sessions as faint flat rings (DESIGN.md before this); scale
  plates down instead of pulling the camera back (labels shrink to unreadable).
- **Why:** the live board had 15 project regions and about 25 ended sessions against the 3C
  concept's 4 regions and 12 live sessions: plates and labels ran off the right edge and
  ended labels piled into one unreadable cluster. The empty note named a clone-only command.

## D-52 Larger fleets keep the concept's rolling ground; no telemetry row until a source exists (2026-11-16)

- **Chosen:** Woody (2026-11-16): the live map looked lower quality than the 3C concept, and
  the telemetry row should be hidden until there is a data source. (1) With more than four
  project pads, `layoutRegions` packs them into 560 x 400 units instead of 720 x 520, leaving
  a rolling margin inside the 400-unit world, and `reliefRise` sets the relief ramp to 90% of
  the narrowest gap between pads (14 to 70; 70 for four pads or fewer, as before). (2) The
  telemetry row is not rendered unless the T preview is on; the terrain takes its height.
- **Alternatives:** grow the world grid with the fleet (more cells per frame, finer lines on
  screen); scale peak widths with zoom; keep the "Not wired" cards (D-48).
- **Why:** the drawing code is a port of the concept, so the difference was the ground: the
  base relief is flat on pads and needed about 70 units to rise, and with 10 to 15 pads the
  layout filled the world with 34-unit gaps, so almost every scan line stayed straight.
  Four placeholder cards that never fill in read as broken rather than reserved.

## D-53 Unattended `mc init` connects the default agent, GitHub Copilot CLI (2026-11-16)

- **Chosen:** Woody (2026-11-16). With no terminal to ask on and no `--agents`, `mc init`
  connects the default agent (`DEFAULT_AGENTS`, Copilot), prints "No terminal to ask on:
  connecting GitHub Copilot CLI (the default). Use --agents to choose." and carries on as
  if Enter had been pressed (support installers, result lines, exit codes). `--agents`
  still overrides; at a real prompt, three invalid answers still exit 2.
- **Alternatives:** keep D-46's usage line and exit 2 (installs nothing a script did not ask
  for); default only when stdin is closed.
- **Why:** most users are Copilot users (D-46), and the interactive prompt already defaults
  to it on Enter, so a script that runs `mc init` gets the same result as a person who
  accepts the prompt.

## D-54 Restore leaves keyboard focus in the terminal, and finds Copilot and Codex tabs (2026-11-16)

- **Chosen:** found in the Copilot pass (2026-11-16), fixed in T109. (1) `wt-select-tab.ps1`
  skips `SelectionItemPattern.Select()` when the tab is already selected and then calls
  `SetFocus()` on the visible `TermControl`. (2) windows.md 4 rule b also matches `copilot`
  and `codex` in tab names; two agent tabs in one window stay ambiguous (focused window only).
- **Alternatives:** send a click into the terminal area (moves the pointer, depends on layout);
  make tab matching adapter-aware (the platform layer does not know the session's adapter at
  restore time).
- **Why:** after Restore brought a Windows Terminal window forward, keyboard focus sat on the
  tab item, so nothing typed reached the agent until the user clicked into the terminal; this
  held for every WT restore, single-tab windows included, because rule a selects the only
  tab. The W- checklist checked foreground and maximize only. Copilot tabs ("<topic> - GitHub
  Copilot") never matched rule b, so a Copilot tab among others was never selected.

## D-55 The vsix is written outside the bridge package folder (2026-11-16)

- **Chosen:** T110. `scripts/package.mjs` runs the bridge `build` and then `vsce package` with
  `-o` in a fresh temp folder; the bridge `package` script keeps D-43's vsce flags but writes to
  the repo's `release/` (created first; vsce treats a missing `-o` folder as a file name).
- **Alternatives:** keep `-o dist/` and add `*.vsix` to `.vscodeignore` (vsce still reads every
  file's details before applying it).
- **Why:** the gate failed intermittently on both OSes in the package stage; with T104 and T108
  keeping the output, the Linux gate at 869f00f showed `ENOENT ... stat 'dist/vscode-bridge-1.0.0.vsix'`:
  vsce read its own output file, inside the folder it packs, while writing it.


## D-56 Telemetry: session logs, the OTel file and the Copilot SDK (2026-11-16)

- **Chosen:** Woody (2026-11-16), after the spikes in `docs/research/telemetry-metrics.md` 3.4.
  1. **Live data comes from files that Copilot writes.** The daemon reads new lines of
     `<COPILOT_HOME or ~/.copilot>/session-state/<nativeId>/events.jsonl` for each `copilot-cli`
     session, and the OTel JSON-lines files under `<stateDir>/otel/` (option O1: one file for each
     source). It never writes to either. Both carry the session id (`gen_ai.conversation.id` in OTel).
  2. **The Copilot SDK (`@github/copilot-sdk` 1.0.34) is a runtime dependency** of `@mc/daemon` and
     `@mc/cli` (amends D-01, D-02). The daemon uses it for account data only (quota, plan, runtime
     version); it never attaches to a live session, never sends a prompt, never answers a permission.
     It brings `koffi` 3.3.6 beside the platform's `koffi` 2.x, plus `zod`, `lossless-json`,
     `vscode-jsonrpc` and a platform runtime package; all stay externals in the package (D-47).
  3. **Contracts:** `Session.telemetry` (optional, `oneOf null | Telemetry`, `session.schema.json`)
     and `DaemonInfo.copilot` (optional, `oneOf null | CopilotAccount`, `api.schema.json`). Both
     optional so that old state files and fixtures stay valid. No text from prompts, responses,
     tool input or tool output ever goes in them; names and counts only.
  4. **Credits:** `credits.aiCredits` and `aiCreditsToday` stay null until a conversion from
     nano-AIU is proven; T114 reports what the SDK gives (`models.listTokenPriceUnits`).
  5. **`mc doctor copilot`** proves the SDK runtime on one PC (research note 11, checks D1-D10;
     D10 only with `--live`).
  6. **Shell integration** sets `COPILOT_OTEL_FILE_EXPORTER_PATH=<stateDir>/otel/shell-<pid>.jsonl`
     in each shell where it is installed. Content capture stays unset. VS Code OTel settings are
     Woody's to set by hand (ORCHESTRATION 8).
  7. **No UI in this wave.** The board work waits for Woody's references.
- **Alternatives:** SDK attach for live data (spike A: safe, but no live events and no usage);
  OTLP into the daemon (O2: loses data while the daemon restarts); Langfuse (declined by Woody).
- **Why:** the attach gives only a snapshot without usage; the two files are the only local,
  cross-process sources of per-call usage, and they need no change to how Woody starts sessions.
  8. **Codegen (amends T002's generate.mjs):** `maxItems: -1`, so bounded arrays are plain arrays, not a union of tuples (`Telemetry.subagents` would have been a 20-way union; `IngestEnvelope.process.ancestry` was a 16-way one).

## D-57 Copilot traces and spans are kept per session (2026-11-16)

- **Chosen:** Woody (2026-11-16): capture the traces and spans, not only the totals. T117: the daemon groups the span records it already reads (D-56 item 1) by trace into `TraceRun` values (`api.schema.json`), keeps the newest 50 runs per session in `<stateDir>/traces/`, and serves them at `GET /api/sessions/:id/traces`. Only the attributes listed in T117 are copied; no content. Metric records stay unused for now.
- **Alternatives:** only totals on `Session.telemetry` (D-56); a trace backend such as Langfuse or Jaeger (declined).
- **Why:** the per-run tree (model calls, tool calls, waits, compaction) is what the session detail view needs, and the raw OTel files are deleted after 7 days.
- **Also (CR from T114, accepted):** T114 adds `copilot: { current: () => null }` to `makeDeps` in `packages/daemon/test/support/deps.ts`; the new required `DaemonDeps.copilot` broke seven T026 tests. Listed in T114's Files.

## D-58 Three telemetry views: list columns, a session page, a run trace page (2026-11-17)

- **Chosen:** Woody (2026-11-17): keep the Canvas 2D terrain and React as they are (benchmark in `docs/research/ui-render-bench-2026-11-17.md`), and build the other views. (1) The list view gets five sortable telemetry columns. (2) A session page (`#/s/<id>`) replaces the main row with one session's telemetry: six key values, the model-call strip, the runs from `GET /api/sessions/:id/traces`, tools, permissions and input, subagents. (3) A run trace page (`#/s/<id>/run/<traceId>`) draws one run as a waterfall. Routes live in `location.hash`, so the daemon serves nothing new and a reload keeps the page. The details sheet stays; it and each list row link to the session page; key `O` opens it. Specs: `DESIGN.md` section 3a. Tasks T119-T123.
- **Alternatives:** the run trace as a panel inside the session page (a waterfall needs the full width); a client router dependency (not needed for two routes; stack lock).
- **Why:** the telemetry fold (D-56) and the traces (D-57) have no screen yet. The mock-up boards (research note section 10) are the reference; the look follows the existing tokens.
- **Also (orchestrator, after the live check):** with five more columns the list overflowed its card at 1440px and long attention text made rows tall. The list now takes the full main row while open, the attention cell is one line, and the Restore capability column hides under 1600px (`DESIGN.md` 3a). Branch `task/T120b-list-fit`.
- **Not in this decision (D-58):** the four board cards on real data and the header credits pill (research note 10.1, 10.2) are a later task; the T preview keeps its sample data until then.

## D-59 `mc uninstall --all [--purge]` removes everything mission-control added (2026-11-17)

- **Chosen:** Woody (2026-11-17), after asking whether `npm uninstall` removes everything (it does not: npm 7+ runs no uninstall scripts, so the package cannot clean up after itself). T124: `mc uninstall --all` stops the daemon, then runs every installed target's uninstall (from the install manifest, plus claude-code, copilot, codex and shell always, which find our entries without a manifest), continues past a failing target and exits 1 if any failed. `--purge` then deletes the config and state directories, only when every target succeeded, and only directories named `mission-control` (or `MC_HOME/config|state`). The guide's uninstall section becomes two commands: `mc uninstall --all --purge`, then `npm rm -g mission-control-desktop`. The uri-handler and autostart uninstalls get their first tests; SK-08 proves install, `--all --purge`, `npm rm` leaves nothing in the prefix or `MC_HOME`.
- **Alternatives:** a `preuninstall` npm script (npm 7+ never runs it); leaving the per-target commands as the only way (easy to miss one, and the hooks then point at launchers with no target).
- **Not covered:** settings a person added by hand, such as the VS Code `github.copilot.chat.otel.*` keys set at the telemetry go-live (no installer wrote them, so the manifest does not list them).


## D-60 npm workspaces replace pnpm (2026-11-17)

- **Chosen:** Woody (2026-11-17): "switch out pnpm for npm", so a clone needs only Node (npm ships with it). The root `package.json` lists the workspaces explicitly in build order (contracts, platform, core, hook, daemon, ui, vscode-bridge, cli), because `npm run <script> --workspaces` runs them in that order and has no topological sort; `pnpm-workspace.yaml` and `pnpm-lock.yaml` are gone, `package-lock.json` replaces the lock, and inter-package dependencies are `"*"` instead of `workspace:*`. The gate runner puts `node_modules/.bin` first on PATH instead of prefixing `pnpm exec` (plain `npx` would try to download `node`). Command mapping: `pnpm -r build` -> `npm run build`; `pnpm --filter X build` -> `npm run build -w X` (dependencies listed explicitly); `pnpm <script>` -> `npm run <script>`; `pnpm mc <args>` -> `npm run mc -- <args>`; `pnpm exec X` -> `npx X`. The toolchain stage checks npm >= 9 (Node 22+ bundles npm 10 or later, but a distro npm such as Ubuntu 26.04's 9.2 is enough: workspaces, `npm exec -w` and lockfile v3 all predate npm 9). The product package (`mission-control-desktop`) was already installed with npm and does not change; it is still not published to npmjs.
- **Alternatives:** keep pnpm (an extra tool to install for every clone); a topological runner script (`--workspaces` order is enough for eight packages).
- **Not covered:** historical records (`docs/checkpoints/`, `docs/validation/` logs, `docs/review/`, `docs/tasks/T###.md`, `CHECKPOINT.md` history, earlier decisions) keep their pnpm wording as written. pnpm's `allowBuilds` list is gone: npm runs every install script, including keytar's and usocket's, which pnpm skipped. The first `npm install` resolved the existing ranges afresh, so a few direct dependencies moved by a patch or minor: `@playwright/test` 1.65.0 -> 1.65.1 (new Chromium download: `npx playwright install chromium`), `ws` 8.22.2 -> 8.23.0, `koffi` 2.16.3 -> 2.16.4, `prettier` 3.10.0 -> 3.10.1, `typescript-eslint` 8.72.2 -> 8.73.0. npm hoists dependencies to the root `node_modules`, so `scripts/package.mjs` reads an external's version there unless the package has its own copy.

## D-61 Telemetry from Claude Code transcripts; AI Credits; the board on real data (2026-11-17)

- **Chosen:** Woody (2026-11-17): "build everything out". Most live sessions on dev-pc are Claude Code, which had no telemetry source, and the board cards still showed T-preview sample data. T125:
  1. **Claude Code source.** The daemon reads each live `claude-code` session's transcript, `<claudeHome>/projects/<slug>/<nativeId>.jsonl`, and its subagent transcripts `<nativeId>/subagents/agent-<id>.jsonl` (with `agent-<id>.meta.json` for `agentType` and the launching `toolUseId`), new lines only, read-only. `claudeHome` is `CLAUDE_CONFIG_DIR`, else `<MC_HOME>/claude` when `MC_HOME` is set (test hygiene), else `~/.claude`. The session id must match `^[A-Za-z0-9_-]{1,128}$`; a missing transcript is looked up again every 30 s. `Telemetry.sources` gains `transcript`.
  2. **The fold** (`createClaudeFold`, `packages/core/src/claude-telemetry.ts`, pure). Usage counts once per `message.id` (Claude Code writes one line per content block with the same usage): `tokens.input` = `input_tokens` (uncached), `cacheRead`, `cacheWrite` = `cache_creation_input_tokens`, `reasoning` = `output_tokens_details.thinking_tokens`. Token rate = input + cache write + output of calls in the last 60 s (cache reads excluded: re-reading a cached prompt is not new work). Context = the newest main-thread prompt (input + cache read + cache write) over an estimated window: 1M when the model id says `[1m]` or a prompt or compaction `preTokens` over 200k was seen, else 200k (shown with `≈`). Latency: a call starts at the prompt or the previous tool result; ttft is its first block, duration its last. `isApiErrorMessage` lines are failed calls (rate-limited when the error names a rate limit, 429 or overload). Tools from `tool_use` / `tool_result` (`is_error` is a failure; `Skill` counts under the skill name). Permissions count only a person's decision or a refusal (`permissionDecision.source` `user*`, or `decision` `reject`); waits are not in the transcript. Subagents: one row per agent file. Credits stay null: Claude Code on a subscription has no per-call price.
  3. **Traces.** The fold emits span records in the Copilot span shape the trace store already reads (D-57): one run per prompt (`promptId`), root `invoke_agent claude-code` closed by `system/turn_duration` (or, interrupted, at its last activity with status unset when the next prompt starts), a `chat <model>` span per model call, an `execute_tool <name>` span per tool, a `chat compaction` span per `compact_boundary`; a subagent's spans hang under the Agent tool span that launched it. No text: names, ids, times and counts only.
  4. **AI Credits.** `credits.aiCredits = nanoAiu / 1e9` and `aiCreditsToday = nanoAiuToday / 1e9`. Source: the Copilot CLI 1.0.112 bundle defines `NANO_AIU_PER_AIU = 1e9` and converts a session cap with `maxNanoAiu = maxAiCredits * NANO_AIU_PER_AIU`; its footer prints "AI Credits" from the same field. This closes D-56 item 4.
  5. **The board** (research note 10.1, 10.2). The four cards read `Session.telemetry` and `DaemonInfo.copilot`: Token rate (sum, busiest session), Context used (`≈`, nearest full, Over 85%), AI Credits (replaces Cost today; Copilot only; the day total, month use and forecast, a warning over 100%), Error rate (failed calls over calls, last error type, Over 5%). The pill shows the age of the newest value. A card with no source shows a dash and why ("No data yet", "n/a", "Copilot sessions only"), never a number. Sparklines are what the page has seen, one sample every 5 s. The sample generator is deleted. The row shows on its own once any session reports telemetry; T overrides that either way (hide it, or show it with "No data" cards). Terrain peaks take their height from the token rate (log scale, 50k tok/min = full) where a session reports one, else activity. The header gets a credits pill ("2.50 AIC today · 40% of month · forecast 92%"); a Needs you card gets one line: credits, context, failed tools.
- **Alternatives:** Claude Code's own OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY`; it exports metrics and log events over OTLP or the console, not a file the daemon could read without a new route, and it needs a change to Woody's environment for every session); the statusline JSON (only while a session renders it, one value at a time); leaving claude-code at "No data".
- **Not covered:** Codex sessions (no reader yet). A `copilot -p` run sends no session hook, so its OTel spans have no session and are dropped (spike 2026-11-17: `shell-<pid>.jsonl` got the spans; no session appeared). The transcript format is Claude Code's own and undocumented; unknown lines are skipped. VS Code Copilot Chat writes its OTel file only after the window reloads with the D-56 settings.

## D-62 Dependency update for the audit: eslint 10, vitest 5, jsdom 31, overrides (2026-11-17)

- **Chosen:** Woody (2026-11-17): "some of the packages have vulnerabilities; adjust them to use the versions" he gave. Root dev dependencies: `@eslint/js` ^10.0.1, `eslint` ^10.14.0 (installed 10.15.0), `jsdom` ^31.0.0, `vitest` ^5.1.0, `vite` ^7.0.0 at the root as well as in `@mc/ui`; others unchanged. Root `overrides`: `node-gyp` ^13.1.0 under `usocket` (drops the `request`, `tar`, `form-data`, `qs`, `tough-cookie` and `uuid` chain), `xml2js` ^0.6.2 under `dbus-next`, and `minimatch@^10.0.0` -> ^11.0.5. npm 11 left the old lock entries in place with the overrides set, so the lockfile was resolved again from scratch; other transitive packages moved within their ranges.
- **Migrations:** Vitest 5 reads no workspace file: `vitest.workspace.ts` became `vitest.config.ts`, which exports the same `projects` and sets `test.projects` (VR-15 and VR-16 read `projects`). ESLint 10's recommended set adds `no-useless-assignment`: ten initial values that every path overwrote were removed (no behaviour change).
- **Result:** `npm audit` 32 (5 critical, 18 high, 9 moderate) -> 20 (19 high, 1 moderate), no critical. Left: `picomatch` (GHSA-fc5q-39xc-vjpf, every version; no fix published) and all that depend on it (vite, vitest, eslint tooling, vsce, json-schema-to-typescript); `@fastify/static` <= 10.1.8 (GHSA-pr96-94w5-mx2h, path traversal in directory listing: the daemon registers it without `list`, so it is not reachable; the fix is 10.1.11, two majors up, not done here) and its `glob`.