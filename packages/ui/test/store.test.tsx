import { act, cleanup, renderHook } from "@testing-library/react";
import type { Session, StateResponse } from "@mc/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetCsrf } from "../src/api.js";
import { useBoard } from "../src/store.js";
import { counts, pollItems, sortSessions } from "../src/sort.js";

const CSRF_1 = "A".repeat(43);
const CSRF_2 = "B".repeat(43);

function at(sec: number): string {
  return new Date(Date.UTC(2026, 10, 12, 10, 0, sec)).toISOString();
}

function session(over: Partial<Session> & { callsign: string; state: Session["state"] }): Session {
  return {
    id: `shell:${over.callsign.toLowerCase()}`,
    adapter: "shell",
    nativeId: over.callsign,
    callsign: over.callsign,
    title: "title",
    cwd: `/work/${over.callsign}`,
    project: "proj",
    branch: "main",
    attention: { active: false, reason: null, since: null, acknowledged: false, message: null },
    startedAt: at(0),
    updatedAt: at(0),
    lastEvent: { name: "PostToolUse", at: at(0), summary: "Tool: Bash" },
    process: { agentPid: null, alive: null },
    host: { kind: "unknown", app: null, os: "linux", display: null, multiplexer: null },
    restore: { capability: "none", reason: null, lastResult: null },
    stats: { prompts: 0, tools: 0, notifications: 0, events: 0 },
    endReason: null,
    ...over,
  };
}

function stateResponse(sessions: Session[], seq = 0): StateResponse {
  return {
    seq,
    sessions,
    daemon: {
      pid: 1,
      version: "0.1.0",
      startedAt: at(0),
      port: 47800,
      configOk: true,
      configError: null,
      bridges: 0,
    },
    capabilities: { os: "linux", display: null, focus: "none", notify: false, notifyClick: false, issues: [] },
  };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  fireClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

type Route = (init: RequestInit) => Response;
let routes: Record<string, Route>;
let calls: { method: string; path: string; headers: Record<string, string>; body: string | undefined }[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function headersOf(init: RequestInit): Record<string, string> {
  return { ...((init.headers as Record<string, string> | undefined) ?? {}) };
}

/** Lets pending promise chains (fetch mocks, then the store's updates) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountBoard() {
  const hook = renderHook(() => useBoard());
  return hook;
}

beforeEach(() => {
  sessionStorage.clear();
  forgetCsrf();
  FakeWebSocket.instances = [];
  routes = {};
  calls = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, path, headers: headersOf(init), body: init.body as string | undefined });
      const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
      if (!route) return json({ error: "not_found" }, 404);
      return route(init);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  forgetCsrf();
});

describe("T032 UI data layer", () => {
  it("US-01 actions.pair posts the code, stores the csrf, clears needsPairing and loads state", async () => {
    routes["GET /api/state"] = () => json({ error: "unauthorized" }, 401);
    routes["POST /api/pair"] = () => json({ csrf: CSRF_1 });
    const { result } = mountBoard();
    await settle();
    expect(result.current.board.needsPairing).toBe(true);

    routes["GET /api/state"] = () => json(stateResponse([session({ callsign: "MC-01", state: "idle" })]));
    let ok = false;
    await act(async () => {
      ok = await result.current.actions.pair("ABCD-2345");
    });
    await settle();

    expect(ok).toBe(true);
    expect(result.current.board.needsPairing).toBe(false);
    expect(result.current.board.state?.sessions).toHaveLength(1);
    expect(sessionStorage.getItem("mc.csrf")).toBe(CSRF_1);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/pair");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ code: "ABCD-2345" });
    expect(FakeWebSocket.instances.at(-1)?.url).toMatch(/\/api\/ws$/);
  });

  it("US-02 401 on state sets needsPairing", async () => {
    routes["GET /api/state"] = () => json({ error: "unauthorized" }, 401);
    const { result } = mountBoard();
    await settle();
    expect(result.current.board.needsPairing).toBe(true);
    expect(result.current.board.state).toBeNull();
  });

  it("US-03 hello replaces state; upsert and remove apply by id", async () => {
    routes["GET /api/state"] = () => json(stateResponse([]));
    const { result } = mountBoard();
    await settle();
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    const a = session({ callsign: "MC-01", state: "working" });
    const b = session({ callsign: "MC-02", state: "idle" });
    await act(async () => ws?.emit({ type: "hello", seq: 1, state: stateResponse([a, b], 1) }));
    expect(result.current.board.state?.sessions.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(result.current.board.link).toBe("open");

    const a2 = { ...a, state: "needs_input" as const };
    const c = session({ callsign: "MC-03", state: "starting" });
    await act(async () => ws?.emit({ type: "session.upsert", seq: 2, session: a2 }));
    await act(async () => ws?.emit({ type: "session.upsert", seq: 3, session: c }));
    await act(async () => ws?.emit({ type: "session.remove", seq: 4, id: b.id }));

    const sessions = result.current.board.state?.sessions ?? [];
    expect(sessions.map((s) => s.id)).toEqual([a.id, c.id]);
    expect(sessions[0]?.state).toBe("needs_input");
  });

  it("US-04 a seq gap closes the socket and reconnects", async () => {
    vi.useFakeTimers();
    routes["GET /api/state"] = () => json(stateResponse([]));
    mountBoard();
    await settle();
    const ws = FakeWebSocket.instances[0];
    await act(async () => ws?.emit({ type: "hello", seq: 1, state: stateResponse([], 1) }));
    await act(async () => ws?.emit({ type: "daemon.update", seq: 3, daemon: stateResponse([]).daemon, capabilities: stateResponse([]).capabilities }));

    expect(ws?.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("US-05 link goes closed and retries every 2 s", async () => {
    vi.useFakeTimers();
    routes["GET /api/state"] = () => json(stateResponse([]));
    const { result } = mountBoard();
    await settle();
    const first = FakeWebSocket.instances[0];
    await act(async () => first?.emit({ type: "hello", seq: 1, state: stateResponse([], 1) }));
    expect(result.current.board.link).toBe("open");

    await act(async () => first?.fireClose());
    expect(result.current.board.link).toBe("closed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.board.link).toBe("connecting");

    await act(async () => FakeWebSocket.instances[1]?.fireClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("US-06 restore sets pending, stores the result for 5 s, then drops it", async () => {
    vi.useFakeTimers();
    const target = session({ callsign: "MC-01", state: "idle" });
    routes["GET /api/state"] = () => json(stateResponse([target]));
    routes["GET /api/csrf"] = () => json({ csrf: CSRF_1 });
    routes["POST /api/sessions/shell%3Amc-01/restore"] = () =>
      json({
        result: { status: "ok", code: "focused", detail: "", at: at(1) },
        session: target,
      });
    const { result } = mountBoard();
    await settle();

    act(() => result.current.actions.restore(target.id));
    expect(result.current.board.pending[target.id]).toBe(true);
    await settle();
    expect(result.current.board.pending[target.id]).toBeUndefined();
    expect(result.current.board.results[target.id]?.result.code).toBe("focused");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(result.current.board.results[target.id]).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.board.results[target.id]).toBeUndefined();
  });

  it("US-07 sortSessions orders permission, error, input, done, working, starting, idle and puts ended and lost in splashdown", () => {
    const list = [
      session({ callsign: "MC-07", state: "idle" }),
      session({ callsign: "MC-06", state: "lost" }),
      session({ callsign: "MC-05", state: "starting" }),
      session({ callsign: "MC-04", state: "working" }),
      session({ callsign: "MC-03", state: "idle", attention: { active: true, reason: "done", since: at(3), acknowledged: false, message: null } }),
      session({ callsign: "MC-02", state: "needs_input", attention: { active: true, reason: "input", since: at(2), acknowledged: false, message: null } }),
      session({ callsign: "MC-01", state: "error", attention: { active: true, reason: "error", since: at(1), acknowledged: false, message: null } }),
      session({ callsign: "MC-08", state: "needs_permission", attention: { active: true, reason: "permission", since: at(4), acknowledged: false, message: null } }),
      session({ callsign: "MC-09", state: "ended" }),
    ];
    const { live, splashdown } = sortSessions(list);
    expect(live.map((s) => s.callsign)).toEqual(["MC-08", "MC-01", "MC-02", "MC-03", "MC-04", "MC-05", "MC-07"]);
    expect(splashdown.map((s) => s.callsign).sort()).toEqual(["MC-06", "MC-09"]);
  });

  it("US-08 pollItems excludes acknowledged attention and orders by reason then since", () => {
    const att = (reason: "permission" | "error" | "input" | "done", since: number, extra: Partial<Session["attention"]> = {}) => ({
      active: true,
      reason,
      since: at(since),
      acknowledged: false,
      message: null,
      ...extra,
    });
    const list = [
      session({ callsign: "MC-10", state: "needs_input", attention: att("input", 1) }),
      session({ callsign: "MC-11", state: "needs_permission", attention: att("permission", 10) }),
      session({ callsign: "MC-12", state: "error", attention: att("error", 5) }),
      session({ callsign: "MC-13", state: "idle", attention: att("done", 2) }),
      session({ callsign: "MC-14", state: "needs_input", attention: att("input", 0, { acknowledged: true }) }),
      session({ callsign: "MC-15", state: "needs_permission", attention: att("permission", 0, { active: false }) }),
    ];
    expect(pollItems(list).map((s) => s.callsign)).toEqual(["MC-12", "MC-11", "MC-10", "MC-13"]);
  });

  it("US-09 counts splits sessions into live, fine, needs you, errors, lost and ended for readiness", () => {
    const att = (reason: "permission" | "input" | "error" | "done") => ({
      active: true,
      reason,
      since: at(1),
      acknowledged: false,
      message: null,
    });
    const list = [
      session({ callsign: "MC-01", state: "idle" }),
      session({ callsign: "MC-02", state: "starting" }),
      session({ callsign: "MC-03", state: "working" }),
      session({ callsign: "MC-04", state: "needs_input", attention: att("input") }),
      session({ callsign: "MC-05", state: "needs_permission", attention: att("permission") }),
      session({ callsign: "MC-06", state: "error", attention: att("error") }),
      session({ callsign: "MC-07", state: "ended" }),
      session({ callsign: "MC-08", state: "lost" }),
      session({ callsign: "MC-09", state: "idle", attention: att("done") }),
    ];
    expect(counts(list)).toEqual({ live: 8, fine: 3, needs: 4, errors: 1, lost: 1, ended: 1 });
    // A dismissed alert no longer counts as needing you.
    expect(counts(list, { "shell:mc-09": at(1) }).needs).toBe(3);
    expect(counts(list, { "shell:mc-09": at(1) }).fine).toBe(4);
  });
  it("US-10 a notify message shows a Web Notification only when the page is hidden and permission is granted", async () => {
    const shown: { title: string; onclick: (() => void) | null }[] = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push({ title, onclick: null });
        notifications.push(this);
      }
    }
    const notifications: FakeNotification[] = [];
    vi.stubGlobal("Notification", FakeNotification);
    const restore = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const target = session({ callsign: "MC-01", state: "needs_permission" });
    routes["GET /api/state"] = () => json(stateResponse([target]));
    routes["GET /api/csrf"] = () => json({ csrf: CSRF_1 });
    routes["POST /api/sessions/shell%3Amc-01/restore"] = () =>
      json({ result: { status: "ok", code: "focused", detail: "", at: at(1) }, session: target });
    mountBoard();
    await settle();
    const ws = FakeWebSocket.instances[0];
    await act(async () => ws?.emit({ type: "hello", seq: 1, state: stateResponse([target], 1) }));

    const notify = {
      type: "notify",
      seq: 2,
      notification: { sessionId: target.id, title: "MISSION CONTROL", body: "MC-01 GO/NO-GO", urgency: "critical", tag: "t1" },
    };
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      await act(async () => ws?.emit(notify));
      expect(shown).toHaveLength(0);

      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      await act(async () => ws?.emit({ ...notify, seq: 3 }));
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toBe("MISSION CONTROL");
      notifications[0]?.onclick?.();
      await settle();
      expect(calls.some((c) => c.path === "/api/sessions/shell%3Amc-01/restore")).toBe(true);
      expect(restore).toHaveBeenCalled();

      FakeNotification.permission = "denied";
      await act(async () => ws?.emit({ ...notify, seq: 4 }));
      expect(shown).toHaveLength(1);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it("US-11 with a valid cookie but no stored csrf, the store fetches /api/csrf and a restore succeeds; a 403 triggers one refetch and one retry", async () => {
    const target = session({ callsign: "MC-01", state: "idle" });
    let csrfCalls = 0;
    let restoreCalls = 0;
    routes["GET /api/state"] = () => json(stateResponse([target]));
    routes["GET /api/csrf"] = () => {
      csrfCalls += 1;
      return json({ csrf: csrfCalls === 1 ? CSRF_1 : CSRF_2 });
    };
    routes["POST /api/sessions/shell%3Amc-01/restore"] = () => {
      restoreCalls += 1;
      if (restoreCalls === 2) return json({ error: "forbidden" }, 403);
      return json({ result: { status: "ok", code: "focused", detail: "", at: at(1) }, session: target });
    };
    const { result } = mountBoard();
    await settle();
    expect(csrfCalls).toBe(1);
    expect(sessionStorage.getItem("mc.csrf")).toBe(CSRF_1);

    act(() => result.current.actions.restore(target.id));
    await settle();
    const first = calls.filter((c) => c.method === "POST");
    expect(first).toHaveLength(1);
    expect(first[0]?.headers["X-MC-CSRF"]).toBe(CSRF_1);
    expect(result.current.board.results[target.id]?.result.code).toBe("focused");

    act(() => result.current.actions.restore(target.id));
    await settle();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(3);
    expect(csrfCalls).toBe(2);
    expect(posts[2]?.headers["X-MC-CSRF"]).toBe(CSRF_2);
    expect(result.current.board.results[target.id]?.result.code).toBe("focused");
  });
});
