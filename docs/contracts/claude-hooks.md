# Contract: Claude Code hook entries

Status: FROZEN at plan freeze. Written by `mc install claude-code` (T051) into the
Claude Code **user** settings file: `$CLAUDE_CONFIG_DIR/settings.json` if
`CLAUDE_CONFIG_DIR` is set, else `~/.claude/settings.json`. Source for the hook
schema: code.claude.com/docs/en/hooks, read 2026-11-08.

## 1. Entries

For each event in the table, one matcher group is appended to `hooks.<Event>` (the
array is created if absent; existing groups are never modified or reordered):

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "<NODE>",
      "args": ["<HOOK_JS>", "claude-code"],
      "async": true,
      "timeout": 5
    }
  ]
}
```

| Event | `async` | `timeout` (s) | Why |
|---|---|---|---|
| SessionStart | true | 5 | card creation |
| UserPromptSubmit | true | 5 | working |
| PermissionRequest | true | 5 | needs_permission; async so it never answers the request |
| Notification | true | 5 | permission_prompt, idle_prompt, elicitation |
| PostToolUse | true | 5 | back to working after a grant |
| PostToolUseFailure | true | 5 | same |
| Stop | true | 5 | done |
| StopFailure | true | 5 | error |
| SessionEnd | **false** | 2 | async hooks may be killed at exit; the hook's own ceiling is 1500 ms |

`<NODE>` is `process.execPath` of the `mc` process doing the install; `<HOOK_JS>` is
the launcher `<stateDir>/bin/mc-hook.js`, which imports the installed entry file
(`docs/PACKAGING.md` 4, D-41; amended 2026-11-15, was the clone's
`packages/hook/dist/mc-hook.js`). Both are written
with forward slashes on Windows (`C:/Program Files/nodejs/node.exe`); no quoting, since
exec form passes each `args` element verbatim.

The hook object is the same on every OS. It uses **exec form** (`args` present): Claude
Code spawns `<NODE>` directly with no shell (code.claude.com/docs/en/hooks, "Exec form
and shell form", read 2026-11-08). Shell form was rejected because on Windows it runs
through Git Bash or PowerShell, adding 0.3-1 s of shell start-up to every event (the
`SessionEnd` hooks share a 1.5 s budget, raised to the `timeout` of 2 s here), and
because the extra shell would sit between the agent and the hook in the ancestry
(`ingest.md` 3 relies on the agent being the hook's direct parent). On Windows exec
form needs a real `.exe`, which `node.exe` is. `"shell"` is not written (ignored when
`args` is set).

Claude Code versions without `args` support would run `<NODE>` alone: node reads the
JSON from stdin as a script, fails with a syntax error, and Claude Code ignores the
failed async hook. Cards then never appear; `mc doctor` (DR-06) reports
"hooks installed but no event received from Claude Code" when the manifest exists and
`events.jsonl` has no `claude-code` envelope.

## 2. Identification and removal

Every hook object the installer writes has `args` of length 2 whose first element ends
in `mc-hook.js` and whose second is `claude-code`. `install-manifest.json` records
`{"claude-code": {"settingsPath": "...", "events": ["SessionStart", ...], "command": "<NODE>", "args": ["<HOOK_JS>", "claude-code"]}}`.
`mc uninstall claude-code` removes every hook object that matches this identification
rule, whatever its `command` and `args[0]` values (D-41.4, amended 2026-11-15), then removes matcher groups left with an empty `hooks` array, then
removes `hooks.<Event>` arrays left empty. Nothing else changes; key order of the rest
of the file is preserved (parse, mutate, `JSON.stringify(obj, null, 2)` + `\n`).

## 3. Safety

- Before writing: copy the file to `settings.json.mc-backup-<yyyyMMddHHmmss>`.
- If the file is not valid JSON: exit 1 without writing, print the parse error.
- Re-running install is idempotent and repairs: a hook object matching the identification
  rule is updated in place to the current `command` and `args`, and extra mc groups for the
  same event are removed (first kept). It is never added twice (D-41.4, amended 2026-11-15).
- `mc install claude-code --dry-run` prints the resulting JSON diff and writes nothing.
