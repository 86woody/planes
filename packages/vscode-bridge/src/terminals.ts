// Tracks vscode.window.terminals, assigns stable t<n> ids, and emits full snapshots debounced.
import type { TerminalInfo } from "./client.js";

export interface Disposable {
  dispose(): unknown;
}

/** Structural subset of vscode.Terminal; tests use a plain fake. */
export interface TerminalLike {
  readonly name: string;
  readonly processId: PromiseLike<number | undefined>;
  show(preserveFocus?: boolean): void;
}

/** Structural subset of vscode.window. */
export interface WindowLike {
  readonly terminals: readonly TerminalLike[];
  readonly activeTerminal: TerminalLike | undefined;
  onDidOpenTerminal(listener: (t: TerminalLike) => unknown): Disposable;
  onDidCloseTerminal(listener: (t: TerminalLike) => unknown): Disposable;
  onDidChangeActiveTerminal(listener: (t: TerminalLike | undefined) => unknown): Disposable;
  onDidChangeTerminalState(listener: (t: TerminalLike) => unknown): Disposable;
}

export interface TerminalTrackerOptions {
  /** Remote windows run remote shells; their PIDs are not local, so report null. */
  remote: boolean;
  debounceMs?: number;
}

export const TERMINAL_DEBOUNCE_MS = 200;

async function pidOf(t: TerminalLike): Promise<number | null> {
  try {
    const pid = await t.processId;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

export class TerminalTracker {
  private readonly ids = new WeakMap<TerminalLike, string>();
  private next = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(terminals: TerminalInfo[]) => void>();
  private readonly subscriptions: Disposable[];

  constructor(
    private readonly window: WindowLike,
    private readonly opts: TerminalTrackerOptions,
  ) {
    const changed = (): void => this.schedule();
    this.subscriptions = [
      window.onDidOpenTerminal(changed),
      window.onDidCloseTerminal(changed),
      window.onDidChangeActiveTerminal(changed),
      window.onDidChangeTerminalState(changed),
    ];
  }

  idFor(t: TerminalLike): string {
    let id = this.ids.get(t);
    if (id === undefined) {
      id = `t${this.next}`;
      this.next += 1;
      this.ids.set(t, id);
    }
    return id;
  }

  find(terminalId: string): TerminalLike | undefined {
    return this.window.terminals.find((t) => this.idFor(t) === terminalId);
  }

  async snapshot(): Promise<TerminalInfo[]> {
    const active = this.window.activeTerminal;
    return Promise.all(
      this.window.terminals.map(async (t): Promise<TerminalInfo> => ({
        terminalId: this.idFor(t),
        name: t.name,
        shellPid: this.opts.remote ? null : await pidOf(t),
        active: t === active,
      })),
    );
  }

  /** Subscribes to debounced snapshots. Returns the unsubscribe function. */
  onChange(listener: (terminals: TerminalInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits one snapshot after the debounce window (used on connect). */
  refresh(): void {
    this.schedule();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const s of this.subscriptions) s.dispose();
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.snapshot().then((terminals) => {
        for (const listener of this.listeners) listener(terminals);
      });
    }, this.opts.debounceMs ?? TERMINAL_DEBOUNCE_MS);
  }
}
