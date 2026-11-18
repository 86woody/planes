# Manual validation: Windows 10 22H2 / Windows 11

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
| W-01 | Claude Code in Windows Terminal (single tab), window minimized; RESTORE in the page | WT window foreground and maximized | | |
| W-02 | WT window with 3 tabs, Claude in tab 2, tab 1 selected; RESTORE | tab 2 selected, or the card shows `TAB: MANUAL` and the window is foreground | | |
| W-03 | Claude Code in a classic conhost window (`conhost.exe pwsh`); RESTORE | window foreground and maximized | | |
| W-04 | Two VS Code windows, Claude in the second terminal of window B; click into each window once; focus window A; RESTORE | window B foreground, maximized, the Claude terminal is the active terminal | | |
| W-05 | Permission prompt raises a toast; click the toast body; then repeat clicking RESTORE in the toast and from the Action Center | the session restores each time, in front (not just flashed), and no console window flashes (the `restore.vbs` shim); record the result, and if it only flashes, retry after `mc install uri-handler --direct` and record that too | | |
| W-06 | VS Code Claude extension panel session; RESTORE | VS Code window foreground; Claude panel revealed (or `focused_window_only` with the Q2 note) | | |
| W-07 | With the session's WT window in front, trigger a permission prompt | no toast | | |
| W-08 | Firefox focused (menu bar hidden); RESTORE a session | Firefox menu bar does not appear (the lone key-up is harmless) | | |
| W-09 | Session window on virtual desktop 2, browser on desktop 1; RESTORE | Windows switches to desktop 2 with the window foreground, or the result chip says FLASHED | | |
| W-10 | Elevated WT window running Claude; RESTORE | card shows NO-GO with "target window is elevated" | | |
