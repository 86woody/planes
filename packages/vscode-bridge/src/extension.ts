// VS Code bridge: connects this window to the local daemon (vscode-bridge.md).
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { BridgeClient, readConnectInfo, type HelloMessage, type RequestResult } from "./client.js";
import { hostPaths } from "./paths.js";
import { TerminalTracker } from "./terminals.js";

/**
 * vscode-bridge.md 4: verified 2026-11-14 against Claude Code 2.1.323. The first two ids
 * exist; claude-code.focus is a fallback for other builds. Order matters: the first id
 * present in getCommands(true) wins.
 */
export const CLAUDE_PANEL_COMMANDS = [
  "claude-vscode.focus",
  "claude-vscode.sidebar.open",
  "claude-code.focus",
] as const;

interface Session {
  client: BridgeClient;
  tracker: TerminalTracker;
  stopWindowEvents: () => void;
}

let session: Session | undefined;

async function focusTerminal(
  tracker: TerminalTracker,
  terminalId: string,
  maximizePanel: boolean,
): Promise<RequestResult> {
  const terminal = tracker.find(terminalId);
  if (terminal === undefined) return { ok: false, detail: "terminal_gone" };
  terminal.show(false);
  if (maximizePanel) {
    await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
  }
  return { ok: true, detail: "terminal shown" };
}

async function focusAgentPanel(adapter: string): Promise<RequestResult> {
  if (adapter !== "claude-code") return { ok: false, detail: "unknown_adapter" };
  const available = new Set(await vscode.commands.getCommands(true));
  const command = CLAUDE_PANEL_COMMANDS.find((id) => available.has(id));
  if (command === undefined) return { ok: false, detail: "no_panel_command" };
  await vscode.commands.executeCommand(command);
  return { ok: true, detail: `ran ${command}` };
}

export function activate(ctx: { subscriptions: { dispose(): unknown }[] }): void {
  if (session !== undefined) return;
  const windowId = randomUUID();
  const paths = hostPaths();
  const tracker = new TerminalTracker(vscode.window, {
    remote: Boolean(vscode.env.remoteName),
  });

  const hello = (): HelloMessage => ({
    type: "hello",
    protocol: 1,
    windowId,
    extHostPid: process.pid,
    appName: vscode.env.appName,
    workspaceName: vscode.workspace.name ?? null,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    remoteName: vscode.env.remoteName ?? null,
    focused: vscode.window.state.focused,
  });

  const client = new BridgeClient({
    readConnectInfo: () => readConnectInfo(paths),
    hello,
    onOpen: () => tracker.refresh(),
    handlers: {
      focusTerminal: (terminalId, maximizePanel) =>
        focusTerminal(tracker, terminalId, maximizePanel),
      focusAgentPanel: (adapter) => focusAgentPanel(adapter),
    },
  });

  const unsubscribe = tracker.onChange((terminals) => client.send({ type: "terminals", terminals }));
  const windowEvents = vscode.window.onDidChangeWindowState((state) =>
    client.send({ type: "windowState", focused: state.focused }),
  );
  session = {
    client,
    tracker,
    stopWindowEvents: () => {
      unsubscribe();
      windowEvents.dispose();
    },
  };
  ctx.subscriptions.push({ dispose: () => deactivate() });
  client.start();
}

export function deactivate(): void {
  if (session === undefined) return;
  const current = session;
  session = undefined;
  current.stopWindowEvents();
  current.client.stop();
  current.tracker.dispose();
}
