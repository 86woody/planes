# Manual validation: Linux (X11 and Wayland)

Copy this file to `docs/validation/<os>-<date>.md` and fill it in. One row per check.
Steps and pass conditions are copied verbatim from the platform doc (section 9).

| Field | Value |
| --- | --- |
| Date | |
| Machine | |
| OS build | |
| Commit | |

| ID | Steps | Pass | Result | Note |
| --- | --- | --- | --- | --- |
| L-01 | X11 (any WM), Claude in a minimized xterm/Alacritty | foreground, maximized | | |
| L-02 | sway | workspace switched, window focused | | |
| L-03 | Hyprland | focused, maximize mode 1 | | |
| L-04 | KDE Plasma 6 Wayland, Konsole | focused, maximized; card says TAB: MANUAL with several tabs | | |
| L-05 | notification click on any of the above | session restored | | |
| L-06 | GNOME Wayland without the extension, then with it | NO-GO card with the fix text, then focused and maximized | | |
| L-07 | session window active; permission prompt | no notification | | |
