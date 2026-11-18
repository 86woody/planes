# Manual validation: macOS 13 Ventura and later

Copy this file to `docs/validation/<os>-<date>.md` and fill it in. One row per check.
Steps and pass conditions are copied verbatim from the platform doc (section 8).

| Field | Value |
| --- | --- |
| Date | |
| Machine | |
| OS build | |
| Commit | |

| ID | Steps | Pass | Result | Note |
| --- | --- | --- | --- | --- |
| M-01 | Terminal.app, 3 tabs, Claude in tab 3, window minimized; RESTORE | window de-minimized, tab 3 selected, window fills the screen's visible frame | | |
| M-02 | iTerm2 split panes, Claude in the right pane of tab 2; RESTORE | tab 2 and that pane selected, zoomed | | |
| M-03 | VS Code with Accessibility granted, two windows; click each once; RESTORE the Claude terminal in the back window | that window front, filled, terminal active | | |
| M-04 | Revoke Automation for Terminal; RESTORE | card shows PERMISSION with the fix text; nothing crashes | | |
| M-05 | alerter installed: permission prompt notification, click | session restored; with only osascript: click does nothing, page card highlighted via Web Notification click | | |
| M-06 | browser frontmost on macOS 14+; RESTORE a Terminal.app session from the page and from a notification click | Terminal frontmost; note in the validation file whether step 2 of 3.4 was needed | | |
| M-07 | session's Terminal window frontmost; permission prompt | no notification | | |
