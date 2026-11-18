# Platform: Linux (X11 and Wayland)

Implementation: `packages/platform/src/linux/` (T045 discover + focus, T046 notify).
External commands are optional and detected at start with `which`; each backend
declares what it needs. D-Bus through `dbus-next` (session bus).

## 1. Backend selection

`display` from the session's origin (`ingest.md` 5) decides per session; the daemon's
own environment may lack `DISPLAY`/`WAYLAND_DISPLAY` when started by systemd, so helper
processes run with the daemon's env overlaid by the display variables (`DISPLAY`,
`WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP`, `SWAYSOCK`, `HYPRLAND_INSTANCE_SIGNATURE`)
of the most recent envelope that had them.

| Condition (first match) | Backend | Needs |
|---|---|---|
| config `linux.waylandBackend` not `auto` | that one (or `none`) | |
| `display == x11` | `x11` | `wmctrl` (required), `xprop` (required), `xdotool` (optional) |
| `SWAYSOCK` set | `sway` | `swaymsg` |
| `HYPRLAND_INSTANCE_SIGNATURE` set | `hyprland` | `hyprctl` |
| `XDG_CURRENT_DESKTOP` contains `KDE` | `kwin` | D-Bus `org.kde.KWin` |
| `XDG_CURRENT_DESKTOP` contains `GNOME` | `gnome-extension` | D-Bus name `org.gnome.Shell` with object `/org/gnome/Shell/Extensions/Windows` (the "Window Calls" extension, extensions.gnome.org id 4724) |
| otherwise (Wayland: COSMIC, Wayfire, river, labwc, niri...) | `none` | |

Wayland has no protocol for one client to activate another client's window; every
Wayland backend above goes through the compositor's private IPC. `none` gives capability
`none`, reason `wayland_unsupported_compositor`, and RESTORE in the page copies the
session's cwd to the clipboard and shows FOCUS MANUALLY (DESIGN.md 6).

## 2. Discovery (`resolveTarget`)

Candidate PIDs: the ancestry entries from the agent upward (the terminal emulator is
usually the first non-shell ancestor). Per backend:

| Backend | Window list | Match |
|---|---|---|
| x11 | `wmctrl -lpx` (id, desktop, pid, WM_CLASS, host, title) | 1) `env.WINDOWID` if it is in the list; 2) windows whose pid is in the candidates, nearest first; several -> 2.1 |
| sway | `swaymsg -t get_tree -r` JSON; walk `nodes` and `floating_nodes` for leaves with `pid` | pid in candidates |
| hyprland | `hyprctl clients -j` (`address`, `pid`, `title`, `class`, `fullscreen`) | pid in candidates |
| kwin | KWin script (section 3.3) reporting `[{internalId, pid, caption, resourceClass}]` via D-Bus callback | pid in candidates |
| gnome-extension | `org.gnome.Shell.Extensions.Windows.List()` returns JSON `[{id, pid, title, wm_class, focus, ...}]` | pid in candidates |

### 2.1 Several windows in one process

GNOME Terminal (`gnome-terminal-server`), Konsole, foot server mode, kitty single
instance and others run many windows in one process. Choose the window whose title
contains the session's `project`, if exactly one; else the topmost in stacking order
(`_NET_CLIENT_LIST_STACKING` on X11; focus history elsewhere if the backend reports
it; else the first). Capability `window`, reason `tab_not_addressable` unless an inner
selector (section 4) can pin it.

### 2.2 Foreground

| Backend | `foregroundWindow()` |
|---|---|
| x11 | `xprop -root _NET_ACTIVE_WINDOW`, then `xprop -id <id> _NET_WM_PID WM_CLASS _NET_WM_NAME` |
| sway | focused leaf in `get_tree` |
| hyprland | `hyprctl activewindow -j` |
| kwin | script reporting `workspace.activeWindow` |
| gnome-extension | `List()` entry with `focus: true` |

### 2.3 Process utilities (T013)

Ancestry from `/proc/<pid>/stat` (field 4 = ppid, field 22 = starttime in clock ticks;
parse after the last `)` because `comm` may contain spaces and parentheses) and
`/proc/<pid>/comm`. `processAlive` = `/proc/<pid>` exists and starttime matches.

## 3. Focus and maximize

### 3.1 X11 (any EWMH window manager)

```
wmctrl -i -r <id> -b remove,hidden            # un-minimize
wmctrl -i -a <id>                             # _NET_ACTIVE_WINDOW (source 2: pager), switches desktop
wmctrl -i -r <id> -b add,maximized_vert,maximized_horz   # maximize: always / if it was hidden
```

Verify `_NET_ACTIVE_WINDOW == id` (poll 25 ms, 500 ms). Fallback if not:
`xdotool windowactivate --sync <id>` (if installed), verify again; else `partial/flashed`
after setting the urgency hint: `wmctrl -i -r <id> -b add,demands_attention`.
GNOME on X11 (Mutter) honours pager-sourced activation.

### 3.2 sway and Hyprland

- sway: `swaymsg '[con_id=<id>] focus'` (switches workspace). Maximize: tiling layouts
  have no maximize; `always` is not applied and the result detail says
  `tiling: maximize skipped`; fullscreen state is never touched. Result `ok/focused`
  when the container is focused.
- Hyprland: `hyprctl dispatch focuswindow address:<addr>`; maximize: if
  `fullscreen == 0` then `hyprctl dispatch fullscreen 1` (mode 1 = maximize, keeps
  gaps and bar); never toggles off an existing fullscreen.

### 3.3 KDE Plasma 6 (KWin scripting)

The daemon exports D-Bus name `org.missioncontrol.Daemon`, object `/`, interface
`org.missioncontrol.Daemon` with method `Report(s json)`. To act, it writes a script to
`<stateDir>/kwin/<nonce>.js`, calls `org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript(path, "mc-<nonce>")`
(returns int id), then `/Scripting/Script<id> org.kde.kwin.Script.run()`, waits for the
`Report` call (1 s timeout), then `unloadScript("mc-<nonce>")` and deletes the file.

Focus script (Plasma 6 API names; Plasma 5 used `clientList`/`activeClient`, detected
with `typeof workspace.windowList === "function"`):

```js
const want = { pid: PID, caption: CAPTION_OR_NULL, maximize: MAXIMIZE };
let hit = null;
for (const w of workspace.windowList()) {
  if (w.pid === want.pid && w.normalWindow && (!want.caption || w.caption.includes(want.caption))) { hit = w; break; }
}
if (hit) { hit.minimized = false; workspace.activeWindow = hit; if (want.maximize) hit.setMaximize(true, true); }
callDBus("org.missioncontrol.Daemon", "/", "org.missioncontrol.Daemon", "Report",
  JSON.stringify({ found: !!hit, active: !!hit && workspace.activeWindow === hit }));
```

Values are injected with `JSON.stringify` (never string concatenation of raw titles).

### 3.4 GNOME Wayland (extension)

`Unminimize(id)` if minimized, `Activate(id)`, then `Maximize(id)` per policy, all on
`org.gnome.Shell.Extensions.Windows` at `/org/gnome/Shell/Extensions/Windows`. Method
names are those of "Window Calls" as of its v18 README; T045 verifies them with
`gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Extensions/Windows`
and records the output in its checkpoint (Q-L1: if the extension is unmaintained for
the installed GNOME version, a minimal extension of our own exposing the same three
methods becomes a new task). Extension absent: capability `none`, reason
`gnome_extension_missing`, fix text "install Window Calls from extensions.gnome.org".

## 4. Inner selectors (Linux and macOS)

### 4.1 tmux (`multiplexer.kind == tmux`)

The socket is the first comma field of `env.TMUX`. All commands use `tmux -S <socket>`.

1. `tmux -S s list-clients -F '#{client_tty} #{client_activity} #{client_session}'`;
   none -> `multiplexer_detached` (capability `none` unless the outer window is known).
2. Pick the client with the highest `client_activity`.
3. `tmux -S s switch-client -c <client_tty> -t <pane>`, then `select-window -t <pane>`,
   then `select-pane -t <pane>`.
4. The outer window: find processes whose controlling tty is `<client_tty>`
   (`ps -t <tty> -o pid=`), take their ancestry, resolve the window with section 2.

### 4.2 kitty, WezTerm

- kitty: `kitty @ --to <KITTY_LISTEN_ON> focus-window --match id:<KITTY_WINDOW_ID>`;
  requires `allow_remote_control` and `listen_on` in kitty.conf; failure ->
  `focused_window_only`.
- WezTerm: `wezterm cli activate-pane --pane-id <WEZTERM_PANE>` (uses
  `WEZTERM_UNIX_SOCKET` from the env overlay).

### 4.3 Not addressable

GNOME Terminal and Ptyxis tabs, Konsole tabs (v1; Konsole's D-Bus could address them
later via `KONSOLE_DBUS_SESSION`), Terminator, Tilix, xfce4-terminal: window only,
`tab_not_addressable`.

## 5. Notifications (T046)

`org.freedesktop.Notifications` at `/org/freedesktop/Notifications`:

- At start, `GetCapabilities()`; `actions` present -> `notifyClick = true`;
  `body-markup` present -> escape `& < >` in body.
- `Notify(app_name "Mission Control", replaces_id <id of the last notification with the
  same tag or 0>, app_icon "<repo>/packages/platform/assets/icon-256.png", summary,
  body, actions ["default", "Restore", "restore", "RESTORE"], hints {"urgency": byte
  0|1|2 (low|normal|critical), "desktop-entry": "mission-control", "category":
  "x-mission-control.attention", "suppress-sound": !sound}, expire_timeout -1)`.
- Signals: `ActionInvoked(id, key)` with key `default` or `restore` -> `onClick(sessionId)`
  for the session that notification belongs to; `NotificationClosed(id, reason)` ->
  forget the id. `withdraw` = `CloseNotification(id)`.
- No notification server on the bus (`org.freedesktop.DBus.Error.ServiceUnknown`):
  `notify` returns null, capability issue `linux_no_notification_server`.

Activation tokens (`ActivationToken` signal, spec 1.2) are not used: they activate the
notifying client's own surface, and the daemon has none.

## 6. URI handler and autostart

- `mc install uri-handler` writes `~/.local/share/applications/mission-control.desktop`:
  `Type=Application`, `Name=Mission Control`, `NoDisplay=true`,
  `Exec="<node>" "<repo>/packages/cli/dist/mc.js" restore %u --from-notification`,
  `MimeType=x-scheme-handler/mission-control;`, then
  `xdg-mime default mission-control.desktop x-scheme-handler/mission-control` and
  `update-desktop-database ~/.local/share/applications` (if present). D-Bus clicks do
  not need it; it serves `mission-control://` links.
- Autostart: `~/.config/systemd/user/mission-control.service`
  (`ExecStart="<node>" "<mc.js>" daemon`, `Restart=on-failure`), `systemctl --user
  enable --now mission-control.service`. Without systemd: `~/.config/autostart/mission-control.desktop`
  with `Exec=... start`.

## 7. Dependencies and `mc doctor`

| Check | Required for | Fix |
|---|---|---|
| `wmctrl`, `xprop` | X11 focus | `sudo apt install wmctrl x11-utils` (Debian/Ubuntu), `sudo dnf install wmctrl xprop` |
| `xdotool` | X11 fallback | optional |
| `swaymsg` / `hyprctl` | sway / Hyprland | ships with the compositor |
| KWin scripting D-Bus | KDE Wayland | ships with Plasma |
| Window Calls extension | GNOME Wayland | extensions.gnome.org/extension/4724 |
| notification server on D-Bus | notifications | every desktop ships one; on bare WMs install `dunst` or `mako` |
| `tmux` >= 3.0 | tmux sessions | |

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| Window manager without EWMH | `wmctrl` errors -> `failed/unsupported` |
| GNOME Wayland focus-stealing prevention ignores Activate | if the window is not focused 500 ms after `Activate`, result `partial/flashed` (Mutter shows its "is ready" notice) |
| KWin script never reports | 1 s timeout -> `timeout`, script unloaded |
| Window id stale | re-resolve once -> `not_found` |
| XWayland window under a Wayland session with backend `none` | `wmctrl` sees it in XWayland; activation is up to the compositor: try the X11 path, verify, else `flashed` |

## 9. How to test

Automated in CI (`ubuntu-24.04`): `xvfb-run` with `openbox` and `dbus-run-session`,
packages `wmctrl x11-utils xdotool xterm openbox tmux`.
`packages/platform/test/os/linux-x11.os.test.ts` (`MC_OS_TESTS=1`):

| ID | Test |
|---|---|
| LO-01 | spawn `xterm -T MC-TEST-<rand> -e sleep 60`; resolve by its PID -> window id from `wmctrl -lp` |
| LO-02 | `xdotool windowminimize`, `focus(always)` -> `ok/focused`; `_NET_WM_STATE` has `_NET_WM_STATE_MAXIMIZED_VERT` and `_HORZ`; `_NET_ACTIVE_WINDOW` equals the id |
| LO-03 | `focus(never)` -> not maximized, active |
| LO-04 | kill xterm, `focus` -> `not_found` |
| LO-05 | a test notification server (dbus-next exporting `org.freedesktop.Notifications` on the private bus) receives `Notify` with the expected summary, actions and urgency; emitting `ActionInvoked(id, "default")` calls `onClick` with the session id |
| LO-06 | tmux: `tmux -S <tmp> new -d`, two windows; inner selector on the pane of the second window (`two`; tmux counts from 0) with an attached client in xterm -> `display -p -t mc '#{window_name}'` is `two` |
| LO-07 | `/proc` ancestry and start-time parsing on a `comm` containing `) (` |

`packages/platform/test/linux-backends.test.ts` (unit, all OSes): sway `get_tree`,
`hyprctl clients -j`, `wmctrl -lpx`, `Window Calls List()` fixture parsing, and the
KWin script text generation (values JSON-escaped).

Manual (Woody, `docs/validation/linux-<date>.md`):

| ID | Steps | Pass |
|---|---|---|
| L-01 | X11 (any WM), Claude in a minimized xterm/Alacritty | foreground, maximized |
| L-02 | sway | workspace switched, window focused |
| L-03 | Hyprland | focused, maximize mode 1 |
| L-04 | KDE Plasma 6 Wayland, Konsole | focused, maximized; card says TAB: MANUAL with several tabs |
| L-05 | notification click on any of the above | session restored |
| L-06 | GNOME Wayland without the extension, then with it | NO-GO card with the fix text, then focused and maximized |
| L-07 | session window active; permission prompt | no notification |
