import type { RawData, WebSocket } from "ws";
import {
  validateBridgeClientMessage,
  type BridgeClientMessage,
  type Host,
  type IngestOrigin,
  type ProcessInfo,
} from "@mc/contracts";
import { VSCODE_NAMES } from "@mc/core";
import type { NativeWindow, PlatformAdapter } from "@mc/platform";
import type { BridgeRegistry, BridgeWindow, Clock, Logger } from "./internal.js";

type Hello = Extract<BridgeClientMessage, { type: "hello" }>;
type TerminalInfo = BridgeWindow["terminals"][number];

interface Entry {
  socket: WebSocket;
  hello: Hello;
  terminals: TerminalInfo[];
  focused: boolean;
  nativeWindow: NativeWindow | null;
  boundAt: number | null;
}

interface Pending {
  windowId: string;
  resolve: (r: { ok: boolean; detail: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HELLO_DEADLINE_MS = 5000;
const BIND_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 2000;

function rawText(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function isVSCodeApp(app: string): boolean {
  return VSCODE_NAMES.includes(app.toLowerCase().replace(/\.exe$/, ""));
}

export function createBridgeRegistry(opts: {
  clock: Clock;
  log: Logger;
  platform: PlatformAdapter;
}): BridgeRegistry {
  const { clock, log, platform } = opts;
  const entries = new Map<string, Entry>();
  const sockets = new Set<WebSocket>();
  const pending = new Map<string, Pending>();
  const listeners = new Set<() => void>();
  let seq = 0;

  function emit(): void {
    for (const cb of [...listeners]) cb();
  }

  function toWindow(windowId: string, e: Entry): BridgeWindow {
    return {
      windowId,
      extHostPid: e.hello.extHostPid,
      workspaceName: e.hello.workspaceName,
      workspaceFolders: [...e.hello.workspaceFolders],
      remoteName: e.hello.remoteName,
      terminals: e.terminals.map((t) => ({ ...t })),
      nativeWindow: e.nativeWindow,
    };
  }

  /** Binds w to owner (or clears it when w is null), clearing the same handle from every other window. Returns true if a binding changed. */
  function bindNative(owner: string, w: NativeWindow | null): boolean {
    const target = entries.get(owner);
    if (!target) return false;
    let changed = false;
    if (w) {
      for (const [id, e] of entries) {
        if (id !== owner && e.nativeWindow?.handle === w.handle) {
          e.nativeWindow = null;
          e.boundAt = null;
          changed = true;
        }
      }
    }
    const prev = target.nativeWindow;
    target.nativeWindow = w;
    if ((prev?.handle ?? null) !== (w?.handle ?? null)) {
      target.boundAt = w ? clock.now() : null;
      changed = true;
    }
    return changed;
  }

  async function bindForeground(windowId: string, socket: WebSocket): Promise<void> {
    if (entries.get(windowId)?.socket !== socket) return;
    let fg: NativeWindow | null;
    try {
      fg = await platform.foregroundWindow();
    } catch (err) {
      log.warn({ windowId, err: String(err) }, "bridge: foregroundWindow failed");
      return;
    }
    if (!fg || !isVSCodeApp(fg.app)) return;
    if (entries.get(windowId)?.socket !== socket) return;
    if (bindNative(windowId, fg)) emit();
  }

  function scheduleBind(windowId: string, socket: WebSocket): void {
    setTimeout(() => {
      void bindForeground(windowId, socket);
    }, BIND_DELAY_MS);
  }

  function attach(socket: WebSocket): void {
    sockets.add(socket);
    let windowId: string | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      helloTimer = null;
      socket.close(1008, "no hello");
    }, HELLO_DEADLINE_MS);

    const refuse = (reason: string): void => {
      socket.close(1008, reason);
    };

    socket.on("message", (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText(data));
      } catch {
        refuse("invalid json");
        return;
      }
      const v = validateBridgeClientMessage(parsed);
      if (!v.ok) {
        refuse("invalid message");
        return;
      }
      const msg = v.value;

      if (windowId === null) {
        if (msg.type !== "hello") {
          refuse("expected hello");
          return;
        }
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = null;
        windowId = msg.windowId;
        const prev = entries.get(windowId);
        entries.set(windowId, {
          socket,
          hello: msg,
          terminals: [],
          focused: msg.focused,
          nativeWindow: prev?.nativeWindow ?? null,
          boundAt: prev?.boundAt ?? null,
        });
        socket.send(JSON.stringify({ type: "welcome", protocol: 1 }));
        emit();
        if (msg.focused) scheduleBind(windowId, socket);
        return;
      }

      const current = windowId;
      const e = entries.get(current);
      if (!e || e.socket !== socket) return; // superseded by a newer hello for this windowId

      switch (msg.type) {
        case "hello":
          refuse("duplicate hello");
          return;
        case "terminals":
          e.terminals = msg.terminals.map((t) => ({ ...t }));
          emit();
          return;
        case "windowState":
          e.focused = msg.focused;
          if (msg.focused) scheduleBind(current, socket);
          return;
        case "result": {
          const p = pending.get(msg.requestId);
          if (!p || p.windowId !== current) return;
          clearTimeout(p.timer);
          pending.delete(msg.requestId);
          p.resolve({ ok: msg.ok, detail: msg.detail });
          return;
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = null;
      if (windowId === null) return;
      const e = entries.get(windowId);
      if (!e || e.socket !== socket) return;
      entries.delete(windowId);
      for (const [rid, p] of pending) {
        if (p.windowId !== windowId) continue;
        clearTimeout(p.timer);
        pending.delete(rid);
        p.resolve({ ok: false, detail: "disconnected" });
      }
      emit();
    });
  }

  function findForSession(
    origin: IngestOrigin,
    hostKind: Host["kind"],
  ): { window: BridgeWindow; terminalId: string | null } | undefined {
    const ancestry: readonly ProcessInfo[] = origin.ancestry;
    for (const p of ancestry) {
      if (hostKind === "vscode-terminal") {
        for (const [id, e] of entries) {
          const t = e.terminals.find((x) => x.shellPid === p.pid);
          if (t) return { window: toWindow(id, e), terminalId: t.terminalId };
        }
      } else if (hostKind === "vscode-extension") {
        for (const [id, e] of entries) {
          if (e.hello.extHostPid === p.pid) return { window: toWindow(id, e), terminalId: null };
        }
      }
    }
    return undefined;
  }

  function request(
    windowId: string,
    msg:
      | { type: "focusTerminal"; terminalId: string; maximizePanel: boolean }
      | { type: "focusAgentPanel"; adapter: string },
  ): Promise<{ ok: boolean; detail: string }> {
    const e = entries.get(windowId);
    if (!e) return Promise.resolve({ ok: false, detail: "no_window" });
    const requestId = `r-${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, detail: "timeout" });
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { windowId, resolve, timer });
      try {
        e.socket.send(JSON.stringify({ ...msg, requestId }));
      } catch {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({ ok: false, detail: "send_failed" });
      }
    });
  }

  return {
    attach,
    windows(): BridgeWindow[] {
      return [...entries].map(([id, e]) => toWindow(id, e));
    },
    findForSession,
    request,
    rebind(windowId: string, w: NativeWindow | null): void {
      if (!entries.has(windowId)) return;
      if (bindNative(windowId, w)) emit();
    },
    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close(): void {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, detail: "disconnected" });
      }
      pending.clear();
      for (const s of sockets) s.close(1001, "daemon stopping");
      sockets.clear();
      entries.clear();
      listeners.clear();
    },
  };
}
