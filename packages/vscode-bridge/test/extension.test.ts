import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeClient, type BridgeSocket } from "../src/client.js";
import { activate, CLAUDE_PANEL_COMMANDS, deactivate } from "../src/extension.js";
import { resolvePaths, type EnvLike } from "../src/paths.js";
import * as mock from "./vscode-mock.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../daemon/test/fixtures/paths.json");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(get: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** A real ws server on port 0 standing in for the daemon. */
class FakeDaemon {
  readonly received: Record<string, unknown>[] = [];
  readonly headers: IncomingHttpHeaders[] = [];
  private readonly sockets: WebSocket[] = [];

  private constructor(private readonly server: WebSocketServer, readonly port: number) {}

  static async start(): Promise<FakeDaemon> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/bridge/v1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const daemon = new FakeDaemon(server, port);
    server.on("connection", (socket, req) => {
      daemon.headers.push(req.headers);
      daemon.sockets.push(socket);
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        daemon.received.push(msg);
        if (msg.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: 1 }));
      });
    });
    return daemon;
  }

  messages(type: string): Record<string, unknown>[] {
    return this.received.filter((m) => m.type === type);
  }

  waitFor(type: string, pred: (m: Record<string, unknown>) => boolean = () => true) {
    return until(
      () => this.received.find((m) => m.type === type && pred(m)),
      `message ${type}`,
    );
  }

  send(msg: unknown): void {
    const socket = this.sockets.at(-1);
    socket?.send(JSON.stringify(msg));
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const ctx = (): { subscriptions: { dispose(): unknown }[] } => ({ subscriptions: [] });

describe("vscode bridge extension", () => {
  let home: string;
  let daemon: FakeDaemon;
  const savedMcHome = process.env.MC_HOME;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "mc-vscode-bridge-"));
    mkdirSync(path.join(home, "state"), { recursive: true });
    daemon = await FakeDaemon.start();
    writeFileSync(
      path.join(home, "state", "daemon.json"),
      JSON.stringify({ pid: 1, port: daemon.port, startedAt: "2026-11-12T00:00:00Z", version: "0.1.0" }),
    );
    writeFileSync(path.join(home, "state", "token"), "test-token");
    process.env.MC_HOME = home;
    mock.resetVscodeMock();
  });

  afterEach(async () => {
    deactivate();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    if (savedMcHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = savedMcHome;
    vi.useRealTimers();
  });

  it("VB-01 hello carries windowId, extHostPid, workspace name and folders, focused", async () => {
    activate(ctx());
    const hello = await daemon.waitFor("hello");
    expect(hello).toMatchObject({
      type: "hello",
      protocol: 1,
      extHostPid: process.pid,
      appName: "Visual Studio Code",
      workspaceName: "schmux",
      workspaceFolders: ["C:\\Users\\you\\Workspace\\apps\\schmux"],
      remoteName: null,
      focused: true,
    });
    expect(hello.windowId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(daemon.headers[0]?.authorization).toBe("Bearer test-token");
  });

  it("VB-02 terminals list includes shellPid and active, debounced to one message", async () => {
    activate(ctx());
    await daemon.waitFor("hello");
    const pwsh = mock.makeTerminal("pwsh", 111);
    const node = mock.makeTerminal("node", 222);
    mock.window.terminals.push(pwsh, node);
    mock.window.activeTerminal = node;
    mock.emitters.openTerminal.fire(pwsh);
    mock.emitters.openTerminal.fire(node);
    mock.emitters.changeActiveTerminal.fire(node);
    mock.emitters.changeTerminalState.fire(node);

    const msg = await daemon.waitFor("terminals");
    expect(msg.terminals).toEqual([
      { terminalId: "t1", name: "pwsh", shellPid: 111, active: false },
      { terminalId: "t2", name: "node", shellPid: 222, active: true },
    ]);
    await sleep(300);
    expect(daemon.messages("terminals")).toHaveLength(1);
  });

  it("VB-03 window focus change sends windowState", async () => {
    activate(ctx());
    await daemon.waitFor("hello");
    mock.emitters.changeWindowState.fire({ focused: false });
    const msg = await daemon.waitFor("windowState");
    expect(msg).toEqual({ type: "windowState", focused: false });
  });

  it("VB-04 focusTerminal shows the terminal and replies ok", async () => {
    const pwsh = mock.makeTerminal("pwsh", 111);
    mock.window.terminals.push(pwsh);
    activate(ctx());
    await daemon.waitFor("hello");
    daemon.send({ type: "focusTerminal", requestId: "r-17", terminalId: "t1", maximizePanel: false });
    const reply = await daemon.waitFor("result", (m) => m.requestId === "r-17");
    expect(reply).toEqual({ type: "result", requestId: "r-17", ok: true, detail: "terminal shown" });
    expect(pwsh.show).toHaveBeenCalledWith(false);
  });

  it("VB-05 focusTerminal for a closed terminal replies terminal_gone", async () => {
    const pwsh = mock.makeTerminal("pwsh", 111);
    mock.window.terminals.push(pwsh);
    activate(ctx());
    await daemon.waitFor("hello");
    mock.window.terminals.length = 0;
    mock.emitters.closeTerminal.fire(pwsh);
    daemon.send({ type: "focusTerminal", requestId: "r-18", terminalId: "t1", maximizePanel: false });
    const reply = await daemon.waitFor("result", (m) => m.requestId === "r-18");
    expect(reply).toMatchObject({ ok: false, detail: "terminal_gone" });
    expect(pwsh.show).not.toHaveBeenCalled();
  });

  it("VB-06 focusAgentPanel runs the first available Claude command, or replies no_panel_command", async () => {
    expect(CLAUDE_PANEL_COMMANDS).toEqual([
      "claude-vscode.focus",
      "claude-vscode.sidebar.open",
      "claude-code.focus",
    ]);
    activate(ctx());
    await daemon.waitFor("hello");

    mock.commandList.push("workbench.action.foo", "claude-code.focus", "claude-vscode.sidebar.open");
    daemon.send({ type: "focusAgentPanel", requestId: "r-19", adapter: "claude-code" });
    const ran = await daemon.waitFor("result", (m) => m.requestId === "r-19");
    expect(ran).toMatchObject({ ok: true });
    expect(mock.executed).toEqual(["claude-vscode.sidebar.open"]);

    mock.commandList.length = 0;
    daemon.send({ type: "focusAgentPanel", requestId: "r-20", adapter: "claude-code" });
    const none = await daemon.waitFor("result", (m) => m.requestId === "r-20");
    expect(none).toEqual({ type: "result", requestId: "r-20", ok: false, detail: "no_panel_command" });
    expect(mock.executed).toEqual(["claude-vscode.sidebar.open"]);
  });

  it("VB-07 reconnect backoff is 1, 2, 5, 10, 10 s", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const attempts: number[] = [];
    const failingSocket = (): BridgeSocket => {
      let onClose: (() => void) | undefined;
      return {
        send: () => undefined,
        close: () => undefined,
        onOpen: () => undefined,
        onMessage: () => undefined,
        onClose: (fn) => {
          onClose = fn;
          queueMicrotask(() => onClose?.());
        },
      };
    };
    const client = new BridgeClient({
      readConnectInfo: async () => ({ port: 1, token: "t" }),
      hello: () => ({
        type: "hello",
        protocol: 1,
        windowId: "w",
        extHostPid: 1,
        appName: "x",
        workspaceName: null,
        workspaceFolders: [],
        remoteName: null,
        focused: true,
      }),
      handlers: {
        focusTerminal: async () => ({ ok: true, detail: "" }),
        focusAgentPanel: async () => ({ ok: true, detail: "" }),
      },
      createSocket: () => {
        attempts.push(Date.now() - started);
        return failingSocket();
      },
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const step of [1000, 2000, 5000, 10000, 10000]) {
      await vi.advanceTimersByTimeAsync(step - 1);
      const before = attempts.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts.length).toBe(before + 1);
    }
    expect(attempts).toEqual([0, 1000, 3000, 8000, 18000, 28000]);
    client.stop();
  });

  it("VB-08 paths match fixtures/paths.json", () => {
    const cases = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      env: EnvLike;
      platform: string;
      home: string;
      expected: Record<string, string>;
    }[];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(resolvePaths(c.env, c.platform, c.home)).toEqual(c.expected);
    }
  });
});
