/* global ObjC, $ */
/* eslint-disable @typescript-eslint/no-unused-vars -- JXA: run() is the entry point, read by osascript */
// macos.md 6: is this process trusted for Accessibility? Prints {"trusted": bool}.
ObjC.import("ApplicationServices");

function run() {
  return JSON.stringify({ trusted: $.AXIsProcessTrusted() === true });
}
