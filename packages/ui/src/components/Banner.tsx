import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import type { BoardActions, BoardState } from "../model.js";

const LOS_AFTER_MS = 3000;

// DESIGN.md 2, banners: pairing, daemon not reachable (after 3 s), config error.
export function Banner(p: { board: BoardState; actions: BoardActions }): JSX.Element | null {
  const { board, actions } = p;
  const [losShown, setLosShown] = useState(false);
  const [code, setCode] = useState("");
  const [rejected, setRejected] = useState(false);
  const losTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Timed from the first close. "connecting" (reconnect attempts) leaves the timer alone;
  // "open" (hello) clears it.
  useEffect(() => {
    if (board.link === "open") {
      if (losTimer.current !== null) clearTimeout(losTimer.current);
      losTimer.current = null;
      setLosShown(false);
    } else if (board.link === "closed" && losTimer.current === null) {
      losTimer.current = setTimeout(() => {
        losTimer.current = null;
        setLosShown(true);
      }, LOS_AFTER_MS);
    }
  }, [board.link]);

  useEffect(
    () => () => {
      if (losTimer.current !== null) clearTimeout(losTimer.current);
    },
    [],
  );

  if (board.needsPairing) {
    const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      const ok = await actions.pair(code.trim().toUpperCase());
      setRejected(!ok);
    };
    return (
      <div data-testid="banner" data-kind="pairing" className="banner" role="alert">
        <i aria-hidden="true" />
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="pair-code">
            Pair this browser: run <code>mc open</code> and enter the code
          </label>
          <input
            id="pair-code"
            data-testid="pair-input"
            type="text"
            maxLength={9}
            autoComplete="off"
            autoFocus
            placeholder="XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button data-testid="pair-submit" className="btn pri" type="submit">
            Pair
          </button>
          {rejected ? (
            <span data-testid="pair-error" className="err">
              Code rejected. Run mc open for a new one.
            </span>
          ) : null}
        </form>
      </div>
    );
  }

  if (losShown) {
    return (
      <div data-testid="banner" data-kind="los" className="banner" role="alert">
        <i aria-hidden="true" />
        <span>Daemon not reachable. Retrying…</span>
      </div>
    );
  }

  const daemon = board.state?.daemon;
  if (daemon && !daemon.configOk) {
    return (
      <div data-testid="banner" data-kind="config" className="banner" role="alert">
        <i aria-hidden="true" />
        <span>Config error: {daemon.configError ?? "unknown"}</span>
      </div>
    );
  }

  return null;
}
