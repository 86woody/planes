-- macos.md 2: find the Terminal.app tab whose tty is argv[1]. Prints one JSON line.
on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then return "{\"windowId\":" & (id of w) & ",\"tab\":" & (index of t) & ",\"minimized\":" & (miniaturized of w) & ",\"title\":\"" & my jsonEscape(name of w) & "\"}"
      end repeat
    end repeat
  end tell
  return "{}"
end run

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
