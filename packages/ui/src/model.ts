// packages/ui/src/model.ts: the board's types (data layer, components, deck view state).
import type { Session, StateResponse, FocusResult, Capabilities, DaemonInfo } from "@mc/contracts";
export type Link = "connecting" | "open" | "closed";
export interface BoardState {
  link: Link;
  needsPairing: boolean;
  state: StateResponse | null;
  results: Record<string, { result: FocusResult; until: number }>;   // by session id, shown 5 s
  pending: Record<string, true>;                                    // restore in flight
  highlight: string | null;                                         // session id from a highlight message
}
export interface BoardActions {
  restore(id: string): void;
  ack(id: string): void;
  dismiss(id: string): void;              // DELETE: ended and lost sessions only
  copyCwd(id: string): void;              // restore with capability none: copy cwd, result "Focus manually"
  pair(code: string): Promise<boolean>;   // POST /api/pair, then reload state; false on 401
}

/** View-only actions the deck owns (selection, the details sheet, client-side dismissal). */
export interface DeckActions {
  select(id: string | null): void;
  details(id: string): void;
  /** Hides a live session's current alert from the Needs you stack (no daemon call). */
  dismissAlert(id: string): void;
  copy(id: string): void;
  toggleMenu(id: string | null): void;
}

/** One card in the Needs you stack. */
export interface CardProps {
  session: Session;
  now: number;
  result: FocusResult | null;
  pending: boolean;
  highlighted: boolean;
  actions: BoardActions;
  selected: boolean;
  menuOpen: boolean;
  deck: DeckActions;
}

export interface BarProps {
  hostname: string;
  now: number;
  link: Link;
  capabilities: Capabilities | null;
  daemon: DaemonInfo | null;
  listMode: boolean;
  telemetry: boolean;
  onList(): void;
  onTelemetry(): void;
  onTheme(): void;
  onHelp(): void;
}
