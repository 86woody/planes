/* global Application */
/* eslint-disable @typescript-eslint/no-unused-vars -- JXA: run() is the entry point, read by osascript */
// macos.md 2: argv[0] = JSON array of process names. Lists the windows (title) of each
// matching process via System Events. Needs Accessibility; never changes window state.
function run(argv) {
  const names = JSON.parse(argv[0]);
  const se = Application("System Events");
  const out = [];
  for (const n of names) {
    let procs;
    try {
      procs = se.processes.whose({ name: String(n) })();
    } catch (e) {
      procs = [];
    }
    for (const p of procs) {
      const pid = p.unixId();
      let wins;
      try {
        wins = p.windows();
      } catch (e) {
        wins = [];
      }
      for (const w of wins) {
        let title;
        try {
          title = String(w.name());
        } catch (e) {
          title = "";
        }
        if (title !== "") out.push({ pid: pid, app: String(n), title: title });
      }
    }
  }
  return JSON.stringify(out);
}
