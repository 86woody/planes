import type { JSX } from "react";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Sessions",
    keys: [
      [["J", "K"], "Next / previous session"],
      [["N"], "Next session that needs you, longest wait first"],
      [["Enter"], "Restore: focus and maximise its window"],
      [["A"], "Acknowledge: seen it, the peak stops glowing"],
      [["D"], "Dismiss the alert, or clear an ended session"],
      [["I"], "Details for the selected session"],
      [["O"], "The selected session's page"],
      [["R"], "Readiness details: the checks and one tick per session"],
      [["Esc"], "Close, then deselect"],
    ],
  },
  {
    title: "Terrain (arrows need the map focused)",
    keys: [
      [["Drag"], "Orbit. Shift-drag or right-drag pans. Wheel or pinch zooms."],
      [["←", "→", "↑", "↓"], "Orbit"],
      [["+", "−"], "Zoom"],
      [["0"], "Reset the view (double-click does the same)"],
      [["1", "9"], "Fly to a project"],
    ],
  },
  {
    title: "Views",
    keys: [
      [["L"], "List: every session as a plain table"],
      [["T"], "Show or hide the telemetry row"],
      [["?"], "This sheet"],
    ],
  },
];

/** DESIGN.md 8, the keyboard map (?). */
export function Help(p: { onClose(): void }): JSX.Element {
  return (
    <div className="help" data-testid="help" role="dialog" aria-modal="true" aria-labelledby="help-h" onClick={p.onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="x" aria-label="Close keyboard help" onClick={p.onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
        <h2 id="help-h">Keys</h2>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([keys, what]) => (
                <div key={what} className="hk">
                  <dt>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p>
          One region per project. Height is recent activity. Orange peaks need you; green-dotted crests are working.
          Green means fine, orange means look now. Nothing else is coloured.
        </p>
      </div>
    </div>
  );
}
