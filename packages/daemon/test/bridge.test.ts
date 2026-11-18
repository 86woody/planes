import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { FakePlatform, type NativeWindow } from "@mc/platform";
import type { IngestOrigin } from "@mc/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeRegistry } from "../src/bridge.js";
import type { BridgeRegistry, BridgeWindow } from "../src/internal.js";

class FakeSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function setup(): { reg: BridgeRegistry; fg: ReturnType<typeof vi.spyOn> } {
  const platform = new FakePlatform();
  const fg = vi.spyOn(platform, "foregroundWindow").mockResolvedValue(null);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reg = createBridgeRegistry({ clock: { now: () => 1000 }, log, platform });
  return { reg, fg };
}

function hello(windowId: string, extHostPid: number, focused = false) {
  return {
    type: "hello",
    protocol: 1,
    windowId,
    extHostPid,
    appName: "Visual Studio Code",
    workspaceName: "schmux",
    workspaceFolders: ["C:\\Users\\you\\Workspace\\apps\\schmux"],
    remoteName: null,
    focused,
  };
}

function send(s: FakeSocket, msg: unknown): void {
  s.emit("message", typeof msg === "string" ? msg : JSON.stringify(msg));
}

function nativeWin(handle: string, app: string): NativeWindow {
  return { os: "windows", handle, pid: 4242, app, title: "x - schmux - Visual Studio Code" };
}

function byId(reg: BridgeRegistry, windowId: string): BridgeWindow {
  const w = reg.windows().find((x) => x.windowId === windowId);
  if (!w) throw new Error(`no window ${windowId}`);
  return w;
}

const origin = (ancestry: { pid: number; name: string }[]): IngestOrigin =>
  ({ os: "windows", hookPid: 1, agent: null, ancestry }) as unknown as IngestOrigin;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bridge registry", () => {
  it("BR-01 hello registers the window and replies welcome", () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));
    expect(JSON.parse(s.send.mock.calls[0]?.[0] as string)).toEqual({ type: "welcome", protocol: 1 });
    const w = byId(reg, "wa");
    expect(w.workspaceName).toBe("schmux");
    expect(w.extHostPid).toBe(3000);
    expect(w.terminals).toEqual([]);
    expect(w.nativeWindow).toBeNull();
  });

  it("BR-02 no hello within 5 s closes with 1008", async () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it("BR-03 invalid message closes with 1008", () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));
    send(s, { type: "terminals", terminals: "not-a-list" });
    expect(s.close).toHaveBeenCalledWith(1008, expect.any(String));

    const t = new FakeSocket();
    reg.attach(t.asWs());
    send(t, "{not json");
    expect(t.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it("BR-04 focused windowState binds the foreground Code.exe window and unbinds it elsewhere", async () => {
    const { reg, fg } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    reg.attach(a.asWs());
    reg.attach(b.asWs());
    send(a, hello("wa", 3000));
    send(b, hello("wb", 3001));

    const codeWin = nativeWin("0x0000000000000A01", "Code.exe");
    fg.mockResolvedValue(codeWin);
    send(a, { type: "windowState", focused: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(byId(reg, "wa").nativeWindow).toEqual(codeWin);

    send(b, { type: "windowState", focused: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(byId(reg, "wa").nativeWindow).toBeNull();
    expect(byId(reg, "wb").nativeWindow).toEqual(codeWin);
  });

  it("BR-05 foreground window of another app does not bind", async () => {
    const { reg, fg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));
    fg.mockResolvedValue(nativeWin("0x0000000000000B02", "chrome.exe"));
    send(s, { type: "windowState", focused: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(byId(reg, "wa").nativeWindow).toBeNull();
  });

  it("BR-06 findForSession matches a terminal shellPid in the ancestry", () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));
    send(s, {
      type: "terminals",
      terminals: [
        { terminalId: "t1", name: "pwsh", shellPid: 2222, active: false },
        { terminalId: "t2", name: "bash", shellPid: 2500, active: true },
      ],
    });
    const hit = reg.findForSession(
      origin([
        { pid: 1111, name: "claude.exe" },
        { pid: 2222, name: "pwsh.exe" },
        { pid: 3000, name: "Code.exe" },
      ]),
      "vscode-terminal",
    );
    expect(hit?.window.windowId).toBe("wa");
    expect(hit?.terminalId).toBe("t1");
    expect(reg.findForSession(origin([{ pid: 9999, name: "pwsh.exe" }]), "vscode-terminal")).toBeUndefined();
  });

  it("BR-07 findForSession matches extHostPid for vscode-extension", () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));
    const hit = reg.findForSession(
      origin([
        { pid: 1111, name: "claude.exe" },
        { pid: 3000, name: "Code.exe" },
      ]),
      "vscode-extension",
    );
    expect(hit?.window.windowId).toBe("wa");
    expect(hit?.terminalId).toBeNull();
  });

  it("BR-08 request resolves on result and times out after 2000 ms", async () => {
    const { reg } = setup();
    const s = new FakeSocket();
    reg.attach(s.asWs());
    send(s, hello("wa", 3000));

    const p1 = reg.request("wa", { type: "focusTerminal", terminalId: "t1", maximizePanel: false });
    const sent = JSON.parse(s.send.mock.calls[1]?.[0] as string) as { requestId: string; type: string };
    expect(sent.type).toBe("focusTerminal");
    expect(sent.requestId).toMatch(/^r-\d+$/);
    send(s, { type: "result", requestId: sent.requestId, ok: true, detail: "terminal shown" });
    await expect(p1).resolves.toEqual({ ok: true, detail: "terminal shown" });

    const p2 = reg.request("wa", { type: "focusAgentPanel", adapter: "claude-code" });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p2).resolves.toEqual({ ok: false, detail: "timeout" });

    await expect(
      reg.request("nope", { type: "focusAgentPanel", adapter: "claude-code" }),
    ).resolves.toEqual({ ok: false, detail: "no_window" });
  });
});
