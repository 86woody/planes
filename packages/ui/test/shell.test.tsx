import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Session, StateResponse, DaemonInfo, Capabilities } from "@mc/contracts";
import type { BoardActions, BoardState } from "../src/model.js";

const hoisted = vi.hoisted(() => ({
  value: null as unknown as { board: BoardState; actions: BoardActions },
}));

vi.mock("../src/store.js", () => ({
  useBoard: () => hoisted.value,
}));

vi.mock("../src/components/Lamp.js", async () => {
  const { createElement } = await import("react");
  return {
    Lamp: (p: { color: string }) => createElement("span", { "data-testid": "lamp", "data-color": p.color }),
  };
});

vi.mock("../src/components/PollStrip.js", () => ({ PollStrip: () => null }));
vi.mock("../src/components/Counts.js", () => ({ Counts: () => null }));
vi.mock("../src/components/Board.js", () => ({ Board: () => null }));

import { App } from "../src/App.js";
import { Banner } from "../src/components/Banner.js";
import { Bar } from "../src/components/Bar.js";

const daemon = (over: Partial<DaemonInfo> = {}): DaemonInfo => ({
  pid: 1,
  version: "0.0.0",
  startedAt: "2026-11-08T20:00:00Z",
  port: 0,
  configOk: true,
  configError: null,
  bridges: 0,
  ...over,
});

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: "linux",
  display: "x11",
  focus: "full",
  notify: true,
  notifyClick: true,
  issues: [],
  ...over,
});

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: "s1",
    callsign: "MC-03",
    project: "schmux",
    state: "needs_permission",
    attention: { active: true, reason: "permission", since: "2026-11-08T20:40:00Z", acknowledged: false, message: null },
    startedAt: "2026-11-08T20:00:00Z",
    updatedAt: "2026-11-08T20:40:00Z",
    lastEvent: { name: "PermissionRequest", at: "2026-11-08T20:40:00Z", summary: "Waiting for permission" },
    ...over,
  }) as Session;

const board = (over: Partial<BoardState> = {}, state: Partial<StateResponse> | null = {}): BoardState => ({
  link: "open",
  needsPairing: false,
  state:
    state === null
      ? null
      : {
          seq: 1,
          sessions: [],
          daemon: daemon(),
          capabilities: caps(),
          ...state,
        },
  results: {},
  pending: {},
  highlight: null,
  ...over,
});

const actions = (): BoardActions => ({
  restore: vi.fn(),
  ack: vi.fn(),
  dismiss: vi.fn(),
  copyCwd: vi.fn(),
  pair: vi.fn().mockResolvedValue(true),
});

function setBoard(b: BoardState): BoardActions {
  const a = actions();
  hoisted.value = { board: b, actions: a };
  return a;
}

function setHost(content: string): void {
  const m = document.createElement("meta");
  m.setAttribute("name", "mc-host");
  m.setAttribute("content", content);
  document.head.appendChild(m);
}

beforeEach(() => {
  document.head.querySelectorAll('meta[name="mc-host"]').forEach((m) => m.remove());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const bar = { listMode: false, telemetry: false, onList: () => undefined, onTelemetry: () => undefined, onTheme: () => undefined, onHelp: () => undefined };

describe("T030 UI shell", () => {
  it("UB-01 the header shows the local time as HH:MM and the host from meta mc-host", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 8, 20, 41, 7));
    setHost("dev-pc");
    setBoard(board());
    render(<App />);
    expect(screen.getByTestId("fd-met").textContent).toBe("20:41");
    expect(screen.getByTestId("fd-host").textContent).toBe("dev-pc");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId("fd-met").textContent).toBe("20:42");
  });

  it("UB-02 the link lamp is go when the link is open and look when closed", () => {
    const { unmount } = render(<Bar hostname="H" now={0} link="open" capabilities={null} daemon={null} {...bar} />);
    expect(within(screen.getByTestId("lamp-link")).getByTestId("lamp").getAttribute("data-color")).toBe("go");
    unmount();
    render(<Bar hostname="H" now={0} link="closed" capabilities={null} daemon={null} {...bar} />);
    expect(within(screen.getByTestId("lamp-link")).getByTestId("lamp").getAttribute("data-color")).toBe("look");
  });

  it("UB-03 the notify lamp follows capabilities: go with click-to-restore, look without, off when unknown", () => {
    const colourFor = (c: Capabilities | null): string | null => {
      cleanup();
      render(<Bar hostname="H" now={0} link="open" capabilities={c} daemon={daemon()} {...bar} />);
      return within(screen.getByTestId("lamp-notify")).getByTestId("lamp").getAttribute("data-color");
    };
    expect(colourFor(caps({ notify: true, notifyClick: true }))).toBe("go");
    expect(colourFor(caps({ notify: true, notifyClick: false }))).toBe("look");
    expect(colourFor(caps({ notify: false, notifyClick: false }))).toBe("look");
    expect(colourFor(null)).toBe("off");
  });

  it("UB-04 the pairing banner wins over the daemon-down and config banners and shows pair-input", () => {
    vi.useFakeTimers();
    setHost("dev-pc");
    setBoard(board({ needsPairing: true, link: "closed" }, { daemon: daemon({ configOk: false, configError: "bad toml" }) }));
    render(<App />);
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    const banner = screen.getByTestId("banner");
    expect(banner.getAttribute("data-kind")).toBe("pairing");
    expect(screen.getByTestId("pair-input")).toBeTruthy();
    expect(screen.queryByText(/Daemon not reachable/)).toBeNull();
    expect(screen.queryByText(/Config error/)).toBeNull();
  });

  it("UB-05 the daemon-down banner appears only after 3 s of closed link", () => {
    vi.useFakeTimers();
    setBoard(board({ link: "closed" }));
    const { rerender } = render(<Banner board={hoisted.value.board} actions={hoisted.value.actions} />);
    expect(screen.queryByTestId("banner")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // A reconnect attempt (connecting) must not restart the 3 s timer (D-34).
    rerender(<Banner board={board({ link: "connecting" })} actions={hoisted.value.actions} />);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.queryByTestId("banner")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("banner").getAttribute("data-kind")).toBe("los");
    expect(screen.getByText("Daemon not reachable. Retrying…")).toBeTruthy();
    // The banner clears on the next successful hello (link open).
    rerender(<Banner board={board({ link: "open" })} actions={hoisted.value.actions} />);
    expect(screen.queryByTestId("banner")).toBeNull();
  });

  it("UB-06 announcer text is \"MC-03 Needs permission schmux\" and assertive for a new permission attention", () => {
    setHost("dev-pc");
    setBoard(board({}, { sessions: [session()] }));
    render(<App />);
    const announcer = screen.getByTestId("announcer");
    expect(announcer.textContent).toBe("MC-03 Needs permission schmux");
    expect(announcer.getAttribute("aria-live")).toBe("assertive");
  });

  it("UB-07 submitting the pair form calls actions.pair with the trimmed upper-cased code; false shows pair-error", async () => {
    const a = actions();
    a.pair = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const b = board({ needsPairing: true });
    render(<Banner board={b} actions={a} />);

    const input = screen.getByTestId("pair-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  abcd-efgh " } });
    fireEvent.click(screen.getByTestId("pair-submit"));
    await waitFor(() => expect(a.pair).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(screen.queryByTestId("pair-error")).toBeNull();

    fireEvent.click(screen.getByTestId("pair-submit"));
    const err = await screen.findByTestId("pair-error");
    expect(err.textContent).toBe("Code rejected. Run mc open for a new one.");
  });
});