import type { JSX } from "react";

// DESIGN.md 3, the empty board: the terrain stays, a quiet note sits in its middle.
// D-51: with only ended sessions left, the note points at the list instead of the install step.
export function Empty(p: { ended?: number }): JSX.Element {
  const ended = p.ended ?? 0;
  if (ended > 0) {
    return (
      <div data-testid="empty" className="empty">
        <h3>No live sessions</h3>
        <p>
          {ended} ended session{ended === 1 ? " is" : "s are"} in the list (L), under Ended and lost.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="empty" className="empty">
      <h3>No sessions yet</h3>
      <p>Start an agent with the hooks installed and its peak rises here.</p>
      <code>mc init</code>
      <p>
        From a clone: <code>npm run mc -- init</code>
      </p>
    </div>
  );
}
