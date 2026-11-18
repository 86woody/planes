-- macos.md 2: find the iTerm2 session by tty (argv[1]); fall back to the unique id (argv[2],
-- the part of ITERM_SESSION_ID after the colon). Prints one JSON line.
on run argv
  set target to item 1 of argv
  set uid to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        repeat with s in sessions of t
          if tty of s is target then return my found(w, tabIndex, s)
        end repeat
      end repeat
    end repeat
    if uid is not "" then
      repeat with w in windows
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          repeat with s in sessions of t
            if unique id of s is uid then return my found(w, tabIndex, s)
          end repeat
        end repeat
      end repeat
    end if
  end tell
  return "{}"
end run

on found(w, tabIndex, s)
  tell application "iTerm2"
    set wid to id of w
    set sid to unique id of s
    set mini to miniaturized of w
    set nm to name of w
  end tell
  return "{\"windowId\":" & wid & ",\"tab\":" & tabIndex & ",\"session\":\"" & my jsonEscape(sid) & "\",\"minimized\":" & mini & ",\"title\":\"" & my jsonEscape(nm) & "\"}"
end found

on jsonEscape(s)
  set s to my replaceText("\\", "\\\\", s)
  set s to my replaceText("\"", "\\\"", s)
  return s
end jsonEscape

on replaceText(findText, replText, sourceText)
  set oldDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to findText
  set parts to text items of sourceText
  set AppleScript's text item delimiters to replText
  set out to parts as text
  set AppleScript's text item delimiters to oldDelims
  return out
end replaceText
