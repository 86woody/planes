-- macos.md 3.1: argv = windowId tabIndex maximize(1|0) l t r b
on run argv
  tell application "Terminal"
    set w to window id (item 1 of argv as integer)
    set miniaturized of w to false
    set selected of tab (item 2 of argv as integer) of w to true
    set index of w to 1
    if item 3 of argv is "1" then set bounds of w to {item 4 of argv as integer, item 5 of argv as integer, item 6 of argv as integer, item 7 of argv as integer}
    activate
  end tell
  return "{\"ok\":true}"
end run
