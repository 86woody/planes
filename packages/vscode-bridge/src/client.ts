// vscode-bridge.md sections 1-3: connection, extension -> daemon, daemon -> extension.
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import type { McPaths } from "./paths.js";

export interface HelloMessage {
  type: "hello";
  protocol: 1;
  windowId: string;
  extHostPid: number;
  appName: string;
  workspaceName: string | null;
  workspaceFolders: string[];
  remoteName: string | null;
  focused: boolean;
}

export interface TerminalInfo {
  terminalId: string;
  name: string;
  shellPid: number | null;
  active: boolean;
}

export interface TerminalsMessage {
  type: "terminals";
  terminals: TerminalInfo[];
}

export interface WindowStateMessage {
  type: "windowState";
  focused: boolean;
}

export interface ResultMessage {
  type: "result";
  requestId: string;
  ok: boolean;
  detail: string;
}

export type ClientMessage = HelloMessage | TerminalsMessage | WindowStateMessage | ResultMessage;

export interface RequestResult {
  ok: boolean;
  detail: string;
}

export interface BridgeHandlers {
  focusTerminal(terminalId: string, maximizePanel: boolean): Promise<RequestResult>;
  focusAgentPanel(adapter: string): Promise<RequestResult>;
}

export interface ConnectInfo {
  port: number;
  token: string;
}

/** The subset of a WebSocket the client uses; tests inject a fake. */
export interface BridgeSocket {
  send(data: string): void;
  close(): void;
  onOpen(fn: () => void): void;
  onMessage(fn: (data: string) => void): void;
  onClose(fn: () => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => BridgeSocket;

export interface BridgeClientOptions {
  readConnectInfo: () => Promise<ConnectInfo | null>;
  hello: () => HelloMessage;
  onOpen?: () => void;
  handlers: BridgeHandlers;
  createSocket?: SocketFactory;
  backoffMs?: readonly number[];
  replyTimeoutMs?: number;
}

export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000];
/** Contract: the daemon times out at 2000 ms; reply a little earlier so its result lands. */
export const REPLY_TIMEOUT_MS = 1500;

/** Reads port (daemon.json) and token (stateDir/token). Null when either is missing. */
export async function readConnectInfo(paths: McPaths): Promise<ConnectInfo | null> {
  try {
    const daemon = JSON.parse(await readFile(paths.daemonFile, "utf8")) as { port?: unknown };
    const token = (await readFile(paths.tokenFile, "utf8")).trim();
    if (typeof daemon.port !== "number" || token === "") return null;
    return { port: daemon.port, token };
  } catch {
    return null;
  }
}

function defaultSocket(url: string, headers: Record<string, string>): BridgeSocket {
  const ws = new WebSocket(url, { headers });
  // ws emits "close" after "error"; the error listener only stops an unhandled-event crash.
  ws.on("error", () => undefined);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (fn) => {
      ws.on("open", () => fn());
    },
    onMessage: (fn) => {
      ws.on("message", (data) => fn(data.toString()));
    },
    onClose: (fn) => {
      ws.on("close", () => fn());
    },
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class BridgeClient {
  private socket: BridgeSocket | undefined;
  private open = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(private readonly opts: BridgeClientOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.open = false;
    socket?.close();
  }

  /** Sends only while connected; state is re-sent after every hello, so drops are harmless. */
  send(msg: ClientMessage): void {
    if (!this.open || this.socket === undefined) return;
    this.socket.send(JSON.stringify(msg));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const info = await this.opts.readConnectInfo().catch(() => null);
    if (this.stopped) return;
    if (info === null) {
      this.scheduleReconnect();
      return;
    }
    const url = `ws://127.0.0.1:${info.port}/bridge/v1`;
    const factory = this.opts.createSocket ?? defaultSocket;
    const socket = factory(url, { Authorization: `Bearer ${info.token}` });
    this.socket = socket;
    socket.onOpen(() => {
      if (this.socket !== socket) return;
      this.open = true;
      this.send(this.opts.hello());
      this.opts.onOpen?.();
    });
    socket.onMessage((raw) => this.onMessage(socket, raw));
    socket.onClose(() => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.open = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const backoff = this.opts.backoffMs ?? BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 10000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  private onMessage(socket: BridgeSocket, raw: string): void {
    if (this.socket !== socket) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "welcome":
        this.attempt = 0;
        return;
      case "focusTerminal": {
        const requestId = m.requestId;
        const terminalId = m.terminalId;
        if (typeof requestId !== "string" || typeof terminalId !== "string") return;
        const maximize = m.maximizePanel === true;
        void this.reply(socket, requestId, () =>
          this.opts.handlers.focusTerminal(terminalId, maximize),
        );
        return;
      }
      case "focusAgentPanel": {
        const requestId = m.requestId;
        if (typeof requestId !== "string") return;
        const adapter = typeof m.adapter === "string" ? m.adapter : "";
        void this.reply(socket, requestId, () => this.opts.handlers.focusAgentPanel(adapter));
        return;
      }
      default:
        return;
    }
  }

  private async reply(
    socket: BridgeSocket,
    requestId: string,
    run: () => Promise<RequestResult>,
  ): Promise<void> {
    const limit = this.opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RequestResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, detail: "timeout" }), limit);
    });
    const work = Promise.resolve()
      .then(run)
      .catch((e: unknown): RequestResult => ({ ok: false, detail: `error: ${errorText(e)}` }));
    const result = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (this.socket !== socket) return;
    this.send({ type: "result", requestId, ok: result.ok, detail: result.detail });
  }
}
