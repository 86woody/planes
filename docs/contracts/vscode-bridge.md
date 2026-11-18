# Contract: VS Code bridge protocol

Status: FROZEN at plan freeze. Daemon side: `packages/daemon/src/bridge.ts` (T024).
Extension side: `packages/vscode-bridge` (T052). Message schemas are given inline here;
T002 transcribes them into `packages/contracts/schemas/bridge.schema.json`
(`$defs.BridgeClientMessage`, `$defs.BridgeServerMessage`).

## 1. Connection

- URL `ws://127.0.0.1:<port>/bridge/v1`; header `Authorization: Bearer <token>`. The
  extension reads `port` and `token` from the same paths as the hook
  (`config.md` 1) using Node `fs` in the extension host.
- Remote windows (`vscode.env.remoteName` set: `wsl`, `ssh-remote`, `dev-container`,
  `codespaces`): the extension runs on the UI side only (`"extensionKind": ["ui"]` in
  its package.json), so it always connects to the local daemon. Terminals in a remote
  window run remote shells whose PIDs are not local; the bridge reports them with
  `shellPid: null` and the daemon cannot match sessions to them (restore degrades to
  window-only via the title rule, D-08).
- Reconnect backoff 1, 2, 5, 10, 10, ... seconds. On reconnect, send `hello` again.
- First message from the extension must be `hello` within 5 s or the daemon closes
  with 1008.

## 2. Extension -> daemon

```jsonc
// hello: once per connection
{ "type": "hello", "protocol": 1,
  "windowId": "uuid-v4, generated once per extension activation (one per VS Code window)",
  "extHostPid": 12345,                 // process.pid inside the extension host
  "appName": "Visual Studio Code",     // vscode.env.appName
  "workspaceName": "schmux",           // vscode.workspace.name ?? null
  "workspaceFolders": ["C:\\Users\\you\\Workspace\\apps\\schmux"],  // fsPath list, may be []
  "remoteName": null,                  // vscode.env.remoteName ?? null
  "focused": true }                    // vscode.window.state.focused

// terminals: full list, sent after hello and on every open/close/rename/active change (debounced 200 ms)
{ "type": "terminals",
  "terminals": [ { "terminalId": "t1",            // extension-assigned, stable for the terminal's life
                   "name": "pwsh",                 // terminal.name
                   "shellPid": 23456,              // await terminal.processId, null if unknown or remote
                   "active": true } ] }            // terminal === vscode.window.activeTerminal

// windowState: on vscode.window.onDidChangeWindowState
{ "type": "windowState", "focused": true }

// result: reply to a daemon request
{ "type": "result", "requestId": "r-17", "ok": true, "detail": "terminal shown" }
```

## 3. Daemon -> extension

```jsonc
{ "type": "welcome", "protocol": 1 }                       // reply to hello

// Show a terminal and give it keyboard focus. The daemon has already raised the OS window.
{ "type": "focusTerminal", "requestId": "r-17", "terminalId": "t1", "maximizePanel": false }

// Reveal the Claude Code extension panel (vscode-extension sessions).
{ "type": "focusAgentPanel", "requestId": "r-18", "adapter": "claude-code" }
```

There is no `raiseWindow` request: VS Code exposes no extension API that brings its
own OS window to the foreground, so raising is always the daemon's job through the
platform adapter.

Extension behaviour:

| Request | Extension does | Reply |
|---|---|---|
| `focusTerminal` | find terminal by id; `terminal.show(false)` (preserveFocus=false); if `maximizePanel`, `workbench.action.toggleMaximizedPanel` only when the panel is not already maximized (unknowable: so the daemon always sends `false` in v1) | `ok: true` or `ok: false, detail: "terminal_gone"` |
| `focusAgentPanel` | run the first command id present in `vscode.commands.getCommands(true)` from the list `CLAUDE_PANEL_COMMANDS` (section 4) | `ok`, or `ok: false, detail: "no_panel_command"` |

Reply deadline 2000 ms; after that the daemon treats it as `ok: false, detail: "timeout"`.

## 4. Open item: Claude Code panel command ids

Not documented publicly (PRD Q2). T052 ships
`CLAUDE_PANEL_COMMANDS = ["claude-vscode.focus", "claude-vscode.sidebar.open", "claude-code.focus"]`.
After T052 merges, the orchestrator (with Woody) runs
`vscode.commands.getCommands(true)` filtered by `^claude` in a VS Code that has the
Claude Code extension installed, records the ids in `CHECKPOINT.md`, and reorders this
list and the constant in one commit. That edit is pre-approved (no D-nn needed);
nothing else in this file may change without one.

**Verified 2026-11-14** against Claude Code 2.1.323 (its `package.json`
`contributes.commands`): `claude-vscode.focus` and `claude-vscode.sidebar.open` exist;
`claude-code.focus` does not. The order stays as shipped.

## 5. Daemon side: binding and matching

- Registry: `windowId -> {hello, terminals, socket, nativeWindow | null, boundAt}`.
- Binding (D-08): on `hello` with `focused: true` and on every `windowState
  {focused: true}`, the daemon waits 150 ms, calls `platform.foregroundWindow()`, and if
  the returned window's `app` is a VS Code process name (ingest.md 5 VSCODE_NAMES) binds
  it. A native window bound to one windowId is unbound from any other.
- Title fallback: if unbound, among top-level windows of VS Code processes, the one
  whose title contains ` - <workspaceName> - ` or ends with ` - <workspaceName>` (the
  default `window.title` pattern) and matches exactly one window. Zero or several:
  `vscode_window_unbound`.
- Session match: `vscode-terminal` sessions match the bridge whose `terminals[].shellPid`
  is in the session's `origin.ancestry`; `vscode-extension` sessions match the bridge
  whose `extHostPid` is in the ancestry.
- Restore sequence: `platform.focus({window: bound, inner: null}, opts)` then
  `focusTerminal` or `focusAgentPanel`. Combined result: both ok -> `focused`; OS ok and
  bridge failed -> `focused_window_only`; OS returned `flashed` -> the bridge request is
  still sent (the terminal is selected for when Woody clicks the flashing taskbar
  entry) and the result stays `flashed`; OS `not_found` -> unbind and retry once with
  the title fallback; no bridge for the session ->
  `vscode_bridge_missing` and capability `window` if a title match exists, else `none`.
