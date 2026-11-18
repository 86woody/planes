/* global ObjC, $ */
/* eslint-disable @typescript-eslint/no-unused-vars -- JXA: run() is the entry point, read by osascript */
// macos.md 3.2 (JXA, no permission). Prints the main screen's visibleFrame in Cocoa
// coordinates plus the primary screen height; discover/focus convert it to top-left bounds.
ObjC.import("AppKit");

function run() {
  const screens = $.NSScreen.screens;
  const primaryHeight = screens.objectAtIndex(0).frame.size.height;
  const vf = $.NSScreen.mainScreen.visibleFrame;
  return JSON.stringify({
    primaryHeight: primaryHeight,
    x: vf.origin.x,
    y: vf.origin.y,
    width: vf.size.width,
    height: vf.size.height,
  });
}
