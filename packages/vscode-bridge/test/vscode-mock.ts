// Minimal fake of the `vscode` module. Tests alias `vscode` to this file (vitest.config.ts).
// State is module-level; call resetVscodeMock() in beforeEach.
import { vi } from "vitest";

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface FakeTerminal {
  name: string;
  processId: Promise<number | undefined>;
  show: ReturnType<typeof vi.fn>;
}

export function makeTerminal(name: string, pid: number | undefined): FakeTerminal {
  return { name, processId: Promise.resolve(pid), show: vi.fn() };
}

export const emitters = {
  openTerminal: new EventEmitter<FakeTerminal>(),
  closeTerminal: new EventEmitter<FakeTerminal>(),
  changeActiveTerminal: new EventEmitter<FakeTerminal | undefined>(),
  changeTerminalState: new EventEmitter<FakeTerminal>(),
  changeWindowState: new EventEmitter<{ focused: boolean }>(),
};

export const window = {
  terminals: [] as FakeTerminal[],
  activeTerminal: undefined as FakeTerminal | undefined,
  state: { focused: true },
  onDidOpenTerminal: emitters.openTerminal.event,
  onDidCloseTerminal: emitters.closeTerminal.event,
  onDidChangeActiveTerminal: emitters.changeActiveTerminal.event,
  onDidChangeTerminalState: emitters.changeTerminalState.event,
  onDidChangeWindowState: emitters.changeWindowState.event,
};

export const env = {
  appName: "Visual Studio Code",
  remoteName: undefined as string | undefined,
};

export const workspace = {
  name: "schmux" as string | undefined,
  workspaceFolders: [{ uri: { fsPath: "C:\\Users\\you\\Workspace\\apps\\schmux" } }] as
    | { uri: { fsPath: string } }[]
    | undefined,
};

export const commandList: string[] = [];
export const executed: string[] = [];

export const commands = {
  getCommands: async (_includeInternal?: boolean): Promise<string[]> => [...commandList],
  executeCommand: async (id: string): Promise<void> => {
    executed.push(id);
  },
};

export function resetVscodeMock(): void {
  window.terminals.length = 0;
  window.activeTerminal = undefined;
  window.state.focused = true;
  env.remoteName = undefined;
  workspace.name = "schmux";
  workspace.workspaceFolders = [{ uri: { fsPath: "C:\\Users\\you\\Workspace\\apps\\schmux" } }];
  commandList.length = 0;
  executed.length = 0;
  for (const e of Object.values(emitters)) e.clear();
}
