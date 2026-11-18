import type { JSX } from "react";
import type { Session } from "@mc/contracts";
import type { BoardActions, BoardState, DeckActions } from "../model.js";
import { needsStack, type Dismissed } from "../sort.js";
import { Card } from "./Card.js";

const MAX = 3;

/** DESIGN.md 3, the Needs you stack: at most three cards, then "+N more in the list". */
export function PollStrip(p: {
  sessions: Session[];
  board: BoardState;
  dismissed: Dismissed;
  now: number;
  selected: string | null;
  menuFor: string | null;
  actions: BoardActions;
  deck: DeckActions;
  onMore(): void;
}): JSX.Element {
  const stack = needsStack(p.sessions, p.dismissed);
  return (
    <section className="ny" data-testid="poll" aria-labelledby="ny-h">
      <div className="ny-h">
        <h2 id="ny-h">Needs you</h2>
        <span className="n num" data-testid="poll-count">
          {stack.length}
        </span>
        <span className="hint">
          <kbd aria-hidden="true">N</kbd>next
        </span>
      </div>
      {stack.length === 0 ? (
        <div className="card allclear" data-testid="all-clear">
          <i aria-hidden="true" />
          All clear. Peaks rise here the moment a session asks for you.
        </div>
      ) : (
        stack.slice(0, MAX).map((s) => (
          <Card
            key={s.id}
            session={s}
            now={p.now}
            result={p.board.results[s.id]?.result ?? null}
            pending={p.board.pending[s.id] === true}
            highlighted={p.board.highlight === s.id}
            actions={p.actions}
            selected={p.selected === s.id}
            menuOpen={p.menuFor === s.id}
            deck={p.deck}
          />
        ))
      )}
      {stack.length > MAX && (
        <button type="button" className="link more-n" data-testid="poll-more" onClick={p.onMore}>
          +{stack.length - MAX} more in the list
        </button>
      )}
    </section>
  );
}
