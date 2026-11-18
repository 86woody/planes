/* global ObjC, $, Application */
/* eslint-disable @typescript-eslint/no-unused-vars -- JXA: run() is the entry point, read by osascript */
// macos.md 2: frontmost application. The pid and name need no permission; the window
// title needs Accessibility (System Events) and is null without it.
ObjC.import("AppKit");

function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app) return JSON.stringify(null);
  const pid = app.processIdentifier;
  const name = ObjC.unwrap(app.localizedName);
  let title;
  try {
    const proc = Application("System Events").processes.whose({ unixId: pid })[0];
    title = String(proc.windows[0].name());
  } catch (e) {
    title = null;
  }
  return JSON.stringify({ pid: pid, app: name, title: title });
}
