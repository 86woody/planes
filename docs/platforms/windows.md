# Platform: Windows 10 22H2 / Windows 11

Implementation: `packages/platform/src/windows/` (T040 discover, T041 focus, T042
notify). Win32 calls through `koffi` (`user32.dll`, `kernel32.dll`, `dwmapi.dll`);
UI Automation and WinRT toasts through **Windows PowerShell 5.1**
(`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), never `pwsh` (PowerShell
7 dropped the WinRT projection). All helper scripts are files under
`packages/platform/src/windows/ps/` run with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <args>`, JSON on stdout.

## 1. Capability matrix

| Host | Window | Inner (tab) | Capability |
|---|---|---|---|
| conhost (classic console window) | `consoleHwnd` | n/a (one session per window) | full |
| Windows Terminal | `ownerHwnd` | UI Automation tab select, heuristic (section 4) | full if the tab is identified, else window (`tab_not_addressable`) |
| VS Code integrated terminal | D-08 binding | bridge `focusTerminal` | full with bridge + binding; window with title match only; none without both |
| VS Code Claude extension panel | D-08 binding | bridge `focusAgentPanel` | as above |
| WSL session in Windows Terminal | the hook runs inside Linux (`origin.os = linux`, `env.WSL_DISTRO_NAME` set) and reaches the daemon only with mirrored networking (PRD Q3). Its ancestry is Linux PIDs, useless here. If exactly one `CASCADIA_HOSTING_WINDOW_CLASS` window exists, that one | none | window, else none (`no_window_found`) |
| Elevated (admin) window | - | - | none: a non-elevated process cannot foreground or resize it (UIPI); reason `target_elevated` (D-49) |
| unknown | first ancestor with a visible, unowned, titled top-level window | - | window |

## 2. Discovery (`resolveTarget`, T040)

Win32 functions used (all `W` variants, via koffi):
`IsWindow`, `IsWindowVisible`, `GetWindow(GW_OWNER=4)`, `GetAncestor(GA_ROOTOWNER=3)`,
`GetWindowThreadProcessId`, `GetClassNameW`, `GetWindowTextW`, `EnumWindows`,
`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION=0x1000)`, `QueryFullProcessImageNameW`,
`GetProcessTimes`, `GetExitCodeProcess`, `CloseHandle`, `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS=2)`,
`Process32FirstW`, `Process32NextW`, `IsIconic`, `IsZoomed`, `GetForegroundWindow`.
`GetTokenInformation(TokenElevation)` via `advapi32` `OpenProcessToken` for the
elevated check.

Steps, first success wins:

1. **Hook-provided owner.** If `origin.console.ownerHwnd` is set, `IsWindow` is true,
   and its owning process is `WindowsTerminal.exe` or a VS Code name: that is the window.
2. **Classic console.** If `consoleHwnd` is set, `IsWindow`, and `GetClassNameW` is
   `ConsoleWindowClass`: that is the window (`conhost`).
3. **Pseudoconsole.** If `consoleHwnd`'s class is `PseudoConsoleWindow`, use
   `GetAncestor(consoleHwnd, GA_ROOTOWNER)` (Windows Terminal >= 1.14 sets the owner);
   if that is the HWND itself or 0, continue.
4. **Ancestry scan.** `EnumWindows` once; keep windows that are visible, unowned
   (`GW_OWNER == 0`), have a non-empty title. For each ancestry PID nearest first,
   the windows owned by that PID; one -> it; several -> section 2.1.
5. Nothing: capability `none`, `no_window_found`.

### 2.1 Several windows in one process

Windows Terminal runs every window in one `WindowsTerminal.exe` by default, and VS Code
runs every window in one main process. Without `ownerHwnd` the ambiguity cannot be
resolved for Windows Terminal: choose none, capability `none`, reason
`no_window_found`, detail `ambiguous: <n> windows`. (VS Code never reaches this step:
the daemon resolves VS Code targets through the bridge.)

### 2.2 Foreground and windows of an app

`foregroundWindow()`: `GetForegroundWindow` -> `NativeWindow` with pid, image basename,
title. `listWindows(appNames)`: the step 4 enumeration filtered by image basename.

### 2.3 Process utilities (T013, shared with the hook)

Ancestry: one `CreateToolhelp32Snapshot` (gives pid, parent pid, exe name), walk from
`ppid`; start time: `GetProcessTimes` creation `FILETIME` as a decimal string of the
64-bit value. `processAlive(pid, start)`: `OpenProcess` succeeds,
`GetExitCodeProcess == STILL_ACTIVE (259)`, creation time equals `start` if given.
Processes that refuse `OpenProcess` (access denied, system processes): alive = true,
startTime omitted.

## 3. Focus and maximize (`focus`, T041)

Windows only lets a process set the foreground window if it received the last input
event, is the foreground process, or was granted permission (see
`SetForegroundWindow` remarks, "foreground lock"). A click in the browser gives the
**browser** foreground rights, not the daemon. The algorithm:

1. `IsWindow(h)` else `failed/not_found`. Elevated target (owning process token
   `TokenIsElevated` and daemon not elevated) -> `failed/permission_denied`,
   detail `target window is elevated`.
2. `wasMin = IsIconic(h)`.
3. Show state per `opts.maximize`: `always` -> `ShowWindow(h, SW_MAXIMIZE=3)`;
   `if-minimized` -> `wasMin ? SW_MAXIMIZE : SW_SHOW(5)`; `never` -> `wasMin ? SW_RESTORE(9) : SW_SHOW`.
4. Foreground, `alt-key` strategy (default): `SendInput` one `INPUT_KEYBOARD` with
   `wVk = VK_MENU (0x12)`, `dwFlags = KEYEVENTF_KEYUP (0x2)` (a lone key-up: it makes
   the daemon the last-input process without toggling any menu bar), then
   `SetForegroundWindow(h)`, `BringWindowToTop(h)`. `plain` strategy skips the
   `SendInput`.
5. Verify: poll `GetForegroundWindow() == h` every 25 ms up to 300 ms.
6. If not foreground: `AttachThreadInput(myThread, fgThread, TRUE)`,
   `SetForegroundWindow(h)`, `BringWindowToTop(h)`, `AttachThreadInput(..., FALSE)`;
   verify again (300 ms).
7. Still not: `FlashWindowEx({hwnd: h, dwFlags: FLASHW_ALL|FLASHW_TIMERNOFG (0x3|0xC), uCount: 0})`
   -> `partial/flashed`.
8. Inner selection (Windows Terminal, section 4), then re-verify foreground.
9. Result `ok/focused`, or `partial/focused_window_only` if the inner step failed.

When invoked from a notification click (`opts.fromActivation`), `mc restore` (the
process Windows launched for the click, which does hold foreground rights) calls
`AllowSetForegroundWindow(ASFW_ANY = 0xFFFFFFFF)` before POSTing to the daemon, so
step 4 succeeds without the key trick.

Virtual desktops: `SetForegroundWindow` on a window on another virtual desktop switches
to that desktop on Windows 11 (manual check W-09). If it does not on a given build, the
result is `flashed` and the taskbar entry flashes.

## 4. Windows Terminal tab selection

There is no public API mapping a ConPTY session to a WT tab. Heuristic, via
`ps/wt-tabs.ps1` (UI Automation, `System.Windows.Automation` from
`UIAutomationClient`/`UIAutomationTypes`):

1. `AutomationElement.FromHandle(h)`; find all descendants with
   `ControlType.TabItem`; return `[{index, name, selected}]`.
2. Choose the tab, first rule that yields exactly one:
   a. the window has one tab;
   b. exactly one tab name starts with a Claude Code title glyph (`✳` while idle, or a
      spinner glyph `✢✶✻✽·*` while working) or contains `claude`, `copilot` or `codex`
      (case-insensitive; Copilot CLI titles its tab "<topic> - GitHub Copilot", D-54).
   The platform layer does not know how many sessions share the window or their
   projects, so no rule uses them; two Claude tabs in one window are therefore not
   distinguishable in v1 (`tab_not_addressable` at restore time).3. Select it with `SelectionItemPattern.Select()` (`ps/wt-select-tab.ps1 <hwnd> <index>`),
   skipping `Select()` when it is already selected, then `SetFocus()` on the on-screen
   `TermControl` so typing reaches the session (`Select()` alone leaves keyboard focus on the
   tab strip, D-54).
4. No unique tab: do not change tabs; `focused_window_only`.

`ResolvedTarget.inner = {wtTabTitle}` stores the matched name at resolve time; selection
re-runs the heuristic at restore time because titles change.

## 5. Notifications (`notify`, T042)

### 5.1 One-time registration (`mc install uri-handler`, T051, also run by `mc install claude-code`)

```
HKCU\Software\Classes\AppUserModelId\WoodyDeus.MissionControl
    DisplayName  REG_SZ  Mission Control
    IconUri      REG_SZ  <repo>\packages\platform\assets\icon-256.png
HKCU\Software\Classes\mission-control
    (Default)    REG_SZ  URL:Mission Control
    URL Protocol REG_SZ  ""
HKCU\Software\Classes\mission-control\shell\open\command
    (Default)    REG_SZ  wscript.exe "<stateDir>\restore.vbs" "%1"
```

`<stateDir>\restore.vbs` (written by the same installer; round 1, F24b) launches node
without a console window, so a toast click does not flash one:

```vb
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
u = WScript.Arguments(0)
If InStr(u, """") > 0 Or Left(LCase(u), 18) <> "mission-control://" Then WScript.Quit 2
CreateObject("WScript.Shell").Run """<node.exe>"" ""<repo>\packages\cli\dist\mc.js"" restore """ & u & """ --from-notification", 0, False
```

The shim does not need to hand on foreground rights: the daemon's lone-key-up trick
(section 3 step 4) works without them; `AllowSetForegroundWindow` in `mc restore` is a
bonus when the rights do pass through. W-05 records whether the restore lands in front
from the shim. If it does not, `mc install uri-handler --direct` writes the plain
`"<node.exe>" "<repo>\packages\cli\dist\mc.js" restore "%1" --from-notification`
command instead (console flash accepted).

Written with `reg.exe add` (no admin needed). Unpackaged apps can raise toasts with an
AUMID registered this way (no Start-menu shortcut needed on Windows 10 1903+).

### 5.2 Showing a toast

Cold-starting Windows PowerShell 5.1 and loading the WinRT projection takes 1-2 s, too
close to PA-07 (round 1, F24a). So toasts go through **one long-lived host process** per
daemon run: `ps/toast-host.ps1`, started lazily on the first notify with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, kept alive, restarted on
exit. It reads one JSON request per line on stdin and writes one JSON reply per line on
stdout: `{"id": n, "op": "show", "aumid", "tag", "group", "xml"}` ->
`{"id": n, "ok": true}`; `{"id": n, "op": "remove", "tag", "group", "aumid"}`;
`{"id": n, "op": "history", "aumid"}` -> `{"id": n, "ok": true, "tags": [...]}`.
The host's first statements set `[Console]::InputEncoding` and `[Console]::OutputEncoding`
to `New-Object System.Text.UTF8Encoding $false` (before the first `ReadLine`), and the
daemon writes UTF-8: Windows PowerShell 5.1 otherwise reads redirected stdin in the OEM
code page and every title, which contains `·` (NP-13), would arrive mangled.
Replies are matched by `id`; the host never writes anything else to stdout (errors go
in `{"ok": false, "error"}`). The `show` operation runs:

```powershell
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($toastXml)   # built below, every text XML-escaped
$t = [Windows.UI.Notifications.ToastNotification]::new($xml)
$t.Tag = $tag; $t.Group = 'mc'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($t)
```

```xml
<toast launch="mission-control://restore/<urlencoded id>" activationType="protocol">
  <visual><binding template="ToastGeneric">
    <text>{title}</text><text>{body}</text>
  </binding></visual>
  <actions>
    <action content="RESTORE" activationType="protocol" arguments="mission-control://restore/<urlencoded id>"/>
  </actions>
  <audio silent="{!sound || urgency == low}"/>
</toast>
```

`tag` = first 16 hex chars of SHA-256 of the notification `tag` (WinRT limit 64
chars). Summary notifications (no session) use `launch="mission-control://open"`.
`withdraw`: `ToastNotificationManager.History.Remove(tag, 'mc', aumid)` via the host's
`remove` operation. The daemon withdraws a session's toast when its attention clears.
Timing: the first request of a host process may take up to 6000 ms (cold start); later
requests must reply within 2000 ms (PA-07 as amended). A request that times out kills
and restarts the host and returns null.

### 5.3 Clicks

Windows launches the protocol command (through `restore.vbs`, 5.1). `mc restore <uri> --from-notification` parses
`mission-control://restore/<id>` (or `open`), calls `AllowSetForegroundWindow(ASFW_ANY)`,
POSTs `/api/sessions/<id>/restore {"source":"notification"}` with the bearer token, and
exits. If the restore result is `failed`, it opens the page with the default browser
(`start "" http://127.0.0.1:<port>/`) and the daemon sends `highlight` over the WS.

### 5.4 Suppression by the OS

Do Not Disturb / Focus Assist hides toasts (they go to the notification centre).
`capabilities()` reports `issues: [{code: "windows_dnd_on", severity: "info"}]` when
`HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\NOC_GLOBAL_SETTING_TOASTS_ENABLED`
is 0, and `windows_app_notifications_off` when
`...\Notifications\Settings\WoodyDeus.MissionControl\Enabled` is 0.

## 6. Autostart (`mc install autostart`, T051)

`<stateDir>\autostart.vbs`:
`CreateObject("WScript.Shell").Run """<node.exe>"" ""<repo>\packages\cli\dist\mc.js"" start", 0, False`
and `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `MissionControl` =
`wscript.exe "<stateDir>\autostart.vbs"` (window style 0: no console flash).
`mc start` itself spawns the daemon with `detached: true, windowsHide: true, stdio: "ignore"`.

## 7. Dependencies and permissions (`mc doctor`)

| Check | Required | Fix |
|---|---|---|
| Windows PowerShell 5.1 present | yes | built in; if missing, notifications and WT tab selection are off |
| AUMID and protocol keys present | for notifications | `mc install uri-handler` |
| App notifications enabled for Mission Control | for notifications | Settings > System > Notifications |
| koffi loads | yes | `npm install` (prebuilt binaries for x64 and arm64) |
| Daemon not elevated | yes | run as the normal user; an elevated daemon cannot be reached by non-elevated hooks' toasts and confuses foreground rules |

## 8. Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| Foreground lock refuses | verify step fails twice | `flashed`, taskbar flashes |
| Window closed since resolve | `IsWindow` false | re-resolve once from the stored origin; still nothing -> `not_found` |
| HWND reused by another window | owning PID differs from `NativeWindow.pid` | treated as `not_found` |
| PowerShell helper hangs | 3 s timeout | process killed, `timeout` |
| UIA throws (WT update changed the tree) | non-zero exit | `focused_window_only` |
| Toast API throws (no AUMID) | stderr | `notify` returns null; capability issue `windows_aumid_missing` |
| Secure desktop (UAC prompt, lock screen) | `SetForegroundWindow` fails | `flashed` |

## 9. How to test

Automated, `packages/platform/test/os/windows.os.test.ts`, run with `MC_OS_TESTS=1` on
an interactive desktop (not a service session):

| ID | Test |
|---|---|
| WO-01 | spawn `conhost.exe cmd.exe /k title MC-TEST-<rand>`; resolve by ancestry of the cmd PID -> class `ConsoleWindowClass` |
| WO-02 | minimize it (`ShowWindow SW_MINIMIZE`), `focus(maximize: always)` -> `ok/focused`, `IsZoomed` true, `GetForegroundWindow` equals it |
| WO-03 | `focus(maximize: never)` on a minimized window -> not zoomed, foreground |
| WO-04 | close the window, `focus` -> `not_found` |
| WO-05 | `processAlive` true for the cmd PID with its start time, false with a different start time, false after exit |
| WO-06 | toast with tag `mc-test-<rand>`: `ToastNotificationManager.History.GetHistory(aumid)` contains the tag within 2 s; `withdraw` removes it |
| WO-07 | if `wt.exe` exists: `wt.exe -w new --title MC-TEST-<rand> cmd /k`; `wt-tabs.ps1` returns 1 tab; focus -> `ok/focused` |
| WO-08 | ancestry from a child `node -e` process lists the test runner's node PID and names |

Manual (Woody, recorded in `docs/validation/windows-<date>.md`):

| ID | Steps | Pass |
|---|---|---|
| W-01 | Claude Code in Windows Terminal (single tab), window minimized; RESTORE in the page | WT window foreground and maximized |
| W-02 | WT window with 3 tabs, Claude in tab 2, tab 1 selected; RESTORE | tab 2 selected, or the card shows `TAB: MANUAL` and the window is foreground |
| W-03 | Claude Code in a classic conhost window (`conhost.exe pwsh`); RESTORE | window foreground and maximized |
| W-04 | Two VS Code windows, Claude in the second terminal of window B; click into each window once; focus window A; RESTORE | window B foreground, maximized, the Claude terminal is the active terminal |
| W-05 | Permission prompt raises a toast; click the toast body; then repeat clicking RESTORE in the toast and from the Action Center | the session restores each time, in front (not just flashed), and no console window flashes (the `restore.vbs` shim); record the result, and if it only flashes, retry after `mc install uri-handler --direct` and record that too |
| W-06 | VS Code Claude extension panel session; RESTORE | VS Code window foreground; Claude panel revealed (or `focused_window_only` with the Q2 note) |
| W-07 | With the session's WT window in front, trigger a permission prompt | no toast |
| W-08 | Firefox focused (menu bar hidden); RESTORE a session | Firefox menu bar does not appear (the lone key-up is harmless) |
| W-09 | Session window on virtual desktop 2, browser on desktop 1; RESTORE | Windows switches to desktop 2 with the window foreground, or the result chip says FLASHED |
| W-10 | Elevated WT window running Claude; RESTORE | the card shows capability None with the `target_elevated` fix text ("Running as administrator...") and Restore does not focus it |
