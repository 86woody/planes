-- macos.md 3.1 (iTerm2): argv = windowId tabIndex sessionUniqueId maximize(1|0) l t r b
on run argv
  set wid to item 1 of argv as integer
  set tabIndex to item 2 of argv as integer
  set sid to item 3 of argv
  set doMax to item 4 of argv
  tell application "iTerm2"
    set w to window id wid
    set miniaturized of w to false
    tell w to select
    set t to tab tabIndex of w
    tell t to select
    if sid is not "" then
      repeat with s in sessions of t
        if unique id of s is sid then
          tell s to select
        end if
      end repeat
    end if
    if doMax is "1" then set bounds of w to {item 5 of argv as integer, item 6 of argv as integer, item 7 of argv as integer, item 8 of argv as integer}
    activate
  end tell
  return "{\"ok\":true}"
end run
