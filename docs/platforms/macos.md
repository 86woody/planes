# Platform: macOS 13 Ventura and later

Implementation: `packages/platform/src/macos/` (T043 discover + focus, T044 notify).
Everything goes through `/usr/bin/osascript` child processes running script files
under `packages/platform/src/macos/scripts/` (`.applescript` for Terminal/iTerm2,
`.js` JXA for System Events, AppKit via the ObjC bridge). Arguments are passed as
`osascript <file> <arg1> <arg2>`, read with `on run argv` / `function run(argv)`;
output is one JSON line on stdout.

## 1. Capability matrix

| Host | Window + tab | Permission needed | Capability |
|---|---|---|---|
| Terminal.app | AppleScript: tab by `tty` | Automation (Terminal) | full |
| iTerm2 | AppleScript: session by `tty` (fallback `unique id` from `ITERM_SESSION_ID` after the `:`) | Automation (iTerm2) | full |
| VS Code (terminal or Claude panel) | D-08 binding via System Events window titles + bridge | Accessibility for binding and raise | full with both; without Accessibility: none, `macos_accessibility_denied` |
| WezTerm | `wezterm cli activate-pane --pane-id $WEZTERM_PANE`, window raise by `open -a WezTerm` | none | full |
| kitty | `kitty @ focus-window --match id:<id>` if remote control is on; else app activation | none | full or window |
| tmux inside any of the above | section 4 of `linux.md` (same commands), then the outer terminal | as outer | as outer |
| Other apps (Ghostty, Alacritty, Warp) | app activation by PID + Accessibility raise of the frontmost-title match | Accessibility | window |

## 2. Discovery (`resolveTarget`)

- `origin.tty` is required for Terminal/iTerm2; the hook computes it
  (`ps -o tty= -p <agentPid>`). Missing tty -> capability window.
- Terminal: `scripts/terminal-find.applescript <tty>`:

```applescript
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then return "{\"windowId\":" & (id of w) & ",\"tab\":" & (index of t) & ",\"title\":\"" & (name of w) & "\"}"
      end repeat
    end repeat
  end tell
  return "{}"
end run
```

  (The real script JSON-escapes the title.) Only run when Terminal is already running
  (`pgrep -x Terminal`), never launch it.
- iTerm2: `scripts/iterm-find.applescript <tty> <uniqueId>` iterating
  `windows > tabs > sessions`, matching `tty of s` then `unique id of s`.
- `NativeWindow.handle` = `"<app>:<windowId>"` for scriptable apps, `"<pid>:<titleHash>"`
  for AX-addressed windows.
- `foregroundWindow()`: `scripts/frontmost.js`: AppKit
  `$.NSWorkspace.sharedWorkspace.frontmostApplication` gives `processIdentifier` and
  `localizedName` without any permission; with Accessibility, System Events
  `processes.whose({unixId: pid})[0].windows[0].name()` adds the title (AXMain window).
- `listWindows(appNames)`: System Events, each process whose name matches, each window's
  `name()`. Needs Accessibility; returns `[]` without it.
- Ancestry and liveness (T013): one `ps -A -o pid=,ppid=,lstart=,comm=` call; `lstart`
  is the fixed-width 24-character field (`Sun Nov  8 20:15:03 2026`), `comm` is the
  rest of the line, basename taken. `processAlive`: `process.kill(pid, 0)` plus the
  `lstart` comparison.

## 3. Focus and maximize

"Maximize" is window zoom to the screen's visible frame (D-09), never native full screen.

### 3.1 Terminal.app and iTerm2 (Automation only)

`scripts/terminal-focus.applescript <windowId> <tabIndex> <maximize> <l> <t> <r> <b>`:

```applescript
tell application "Terminal"
  set w to window id (item 1 of argv as integer)
  set miniaturized of w to false
  set selected of tab (item 2 of argv as integer) of w to true
  set index of w to 1
  if item 3 of argv is "1" then set bounds of w to {l, t, r, b}
  activate
end tell
```

iTerm2: `tell w to select`, `tell t to select`, `tell s to select`, `set bounds of w`,
`activate`. The bounds come from 3.2.

### 3.2 Screen visible frame (JXA, no permission)

`scripts/screen-frame.js <x> <y>` returns the `visibleFrame` of the `NSScreen` whose
frame contains the point (the window's current centre, or the main screen if unknown),
converted to top-left coordinates: `top = primaryHeight - (vf.origin.y + vf.size.height)`,
`left = vf.origin.x`, `right = left + vf.size.width`, `bottom = top + vf.size.height`,
where `primaryHeight = NSScreen.screens[0].frame.size.height`.

### 3.3 VS Code and other apps (Accessibility)

`scripts/ax-focus.js <pid> <titleContains> <maximize>`:
System Events process `whose({unixId: pid})`; window whose `name()` contains the title
(first if several); `AXMinimized` false; `perform action "AXRaise"`; set process
`frontmost = true`; if maximize: set `position` and `size` to the visible frame from 3.2.
Without Accessibility (error -25211 or "not allowed assistive access"): `failed/permission_denied`,
reason `macos_accessibility_denied` on the session. For VS Code the daemon still sends the
bridge request, so the terminal is selected inside the window when Woody brings it
forward himself. (An `open -a <app> <folder>` fallback was considered and dropped:
the platform layer does not know the workspace folder; revisit with the bridge.)

### 3.4 Verification

`foregroundWindow()` after acting: frontmost PID equals the target's PID (and, with
Accessibility, the AXMain window title matches). macOS has no documented foreground lock, but since macOS 14 (cooperative app
activation) an `activate` requested from a background process is sometimes refused:
the Dock icon bounces and the app stays behind (reports for Sonoma and macOS 26). So the
result is always verified, never assumed (PA-03):

1. after `activate`, poll `frontmost.js` every 50 ms up to 500 ms;
2. not frontmost: run `scripts/ax-focus.js` for the same PID (System Events
   `frontmost = true`, needs Accessibility) and verify again;
3. still not frontmost: `partial/flashed` (the Dock bounce is macOS's attention
   request), detail `macos activation refused`;
4. frontmost but the AXMain title does not match the target window:
   `partial/focused_window_only`.

Manual row M-06 (below) records which macOS versions needed step 2.

## 4. Notifications

Backends in order of preference, detected at start (`which`):

1. **alerter** (`brew install vjeantet/tap/alerter`): spawn
   `alerter -title T -message B -group <tag> -actions RESTORE -timeout 600 -json`,
   keep the process; it prints one JSON object on exit with `activationType`
   `contentsClicked` or `actionClicked` -> in-process `onClick(sessionId)`;
   `timeout`/`closed` -> nothing. At most 10 live alerter processes; the oldest is killed
   (`withdraw` = kill + `alerter -remove <tag>`).
2. **terminal-notifier** (`brew install terminal-notifier`): `terminal-notifier -title T
   -message B -group <tag> -execute '<node> <mc.js> restore mission-control://restore/<id> --from-notification'`
   (`-sound default` unless silent). Fire and forget; click runs the command.
   `withdraw` = `terminal-notifier -remove <tag>`.
3. **osascript**: `display notification B with title T` (and `sound name "Glass"`).
   No click action (clicking opens Script Editor); `capabilities().notifyClick = false`
   and the page's Web Notification mirror (api.md 5) is the click path, which needs the
   page open and notification permission granted in the browser.

The first notification from alerter or terminal-notifier triggers macOS's "allow
notifications" prompt for that tool. Focus modes (Do Not Disturb) silence them; macOS
offers no reliable query, so no capability issue is raised for it.

## 5. URI handler and autostart

- No custom URL scheme on macOS in v1 (registering one needs an app bundle with
  `CFBundleURLTypes`; deferred, D-02). Notification clicks use alerter or
  terminal-notifier `-execute`.
- Autostart (`mc install autostart`): `~/Library/LaunchAgents/local.mission-control.plist`
  with `ProgramArguments [<node>, <mc.js>, daemon]`, `RunAtLoad true`,
  `KeepAlive {SuccessfulExit: false}`, `StandardErrorPath <stateDir>/launchd.err`;
  loaded with `launchctl bootstrap gui/<uid> <plist>`; removed with `launchctl bootout`.

## 6. Permissions (TCC) and `mc doctor`

| Permission | Needed for | How `mc doctor` checks | Fix text |
|---|---|---|---|
| Automation -> Terminal / iTerm2 | tab find and focus | run `tell application "Terminal" to count windows` only if Terminal is running; error `-1743` = denied | System Settings > Privacy & Security > Automation > enable Terminal (and iTerm2) under the app that runs the daemon |
| Accessibility | VS Code binding, other apps, maximize of non-scriptable apps | JXA `ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()` | System Settings > Privacy & Security > Accessibility > add the app that runs the daemon (Terminal if started from Terminal; the `node` binary at `<process.execPath>` if started by launchd) |
| Notifications for alerter / terminal-notifier | notifications | not checkable | System Settings > Notifications > alerter |

TCC attributes permissions to the "responsible process": the terminal app when the
daemon was started from a terminal, the `node` binary when launchd started it. The
doctor output prints which one applies (`ps -o comm= -p <ppid>` chain).

## 7. Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Automation denied | osascript exit 1, stderr contains `-1743` | `permission_denied`, reason `macos_automation_denied` |
| Accessibility denied | stderr contains `-25211` or `assistive access` | `permission_denied`, reason `macos_accessibility_denied` |
| Terminal not running | `pgrep -x` fails | `not_found` |
| tty not found (tab closed) | find returns `{}` | `not_found` |
| osascript hang (app beachballing) | 3 s timeout | `timeout` |
| Window in another Space / full screen | after `activate`, frontmost PID ok | ok; macOS switches Space |

## 8. How to test

Automated, `packages/platform/test/os/macos.os.test.ts` with `MC_OS_TESTS=1` (CI
`macos-14` runner: Automation is not granted there, so MO-03 asserts the denied path):

| ID | Test |
|---|---|
| MO-01 | `screen-frame.js` returns integers with `right > left`, `bottom > top` |
| MO-02 | `frontmost.js` returns a PID that `processAlive` accepts |
| MO-03 | Terminal find with a bogus tty: returns `{}` when Automation is granted, or `permission_denied` / `macos_automation_denied` when not; never throws |
| MO-04 | `processAlive` start-time mismatch is false |
| MO-05 | notify with backend `osascript` returns a handle and does not throw |
| MO-06 | ancestry parse of a recorded `ps` output fixture (unit, runs everywhere) |

Manual (Woody, `docs/validation/macos-<date>.md`):

| ID | Steps | Pass |
|---|---|---|
| M-01 | Terminal.app, 3 tabs, Claude in tab 3, window minimized; RESTORE | window de-minimized, tab 3 selected, window fills the screen's visible frame |
| M-02 | iTerm2 split panes, Claude in the right pane of tab 2; RESTORE | tab 2 and that pane selected, zoomed |
| M-03 | VS Code with Accessibility granted, two windows; click each once; RESTORE the Claude terminal in the back window | that window front, filled, terminal active |
| M-04 | Revoke Automation for Terminal; RESTORE | card shows PERMISSION with the fix text; nothing crashes |
| M-05 | alerter installed: permission prompt notification, click | session restored; with only osascript: click does nothing, page card highlighted via Web Notification click |
| M-06 | browser frontmost on macOS 14+; RESTORE a Terminal.app session from the page and from a notification click | Terminal frontmost; note in the validation file whether step 2 of 3.4 was needed |
| M-07 | session's Terminal window frontmost; permission prompt | no notification |
