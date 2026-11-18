/* global Application */
/* eslint-disable @typescript-eslint/no-unused-vars -- JXA: run() is the entry point, read by osascript */
// macos.md 3.3: argv = pid titleContains mode(always|if-minimized|never) l t r b
// Raise one window of a process via Accessibility. Maximize (set position and size to the
// visible frame) is decided here from the window's AXMinimized state before it is restored.
function run(argv) {
  const pid = Number(argv[0]);
  const want = argv[1] || "";
  const mode = argv[2];
  const l = Number(argv[3]);
  const t = Number(argv[4]);
  const r = Number(argv[5]);
  const b = Number(argv[6]);

  const se = Application("System Events");
  const proc = se.processes.whose({ unixId: pid })[0];
  if (!proc.exists()) return JSON.stringify({ ok: false, code: "not_found" });

  let win = null;
  for (const w of proc.windows()) {
    if (want === "" || String(w.name()).indexOf(want) >= 0) {
      win = w;
      break;
    }
  }
  if (win === null) return JSON.stringify({ ok: false, code: "not_found" });

  const minimized = win.attributes.byName("AXMinimized").value() === true;
  if (minimized) win.attributes.byName("AXMinimized").value = false;
  win.actions.byName("AXRaise").perform();
  proc.frontmost = true;

  const maximize = mode === "always" || (mode === "if-minimized" && minimized);
  if (maximize) {
    win.position = [l, t];
    win.size = [r - l, b - t];
  }
  return JSON.stringify({ ok: true, minimized: minimized });
}
