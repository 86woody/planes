import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Capabilities, DaemonInfo, Session, StateResponse, TracesResponse } from "@mc/contracts";
import type { BoardActions, BoardState } from "../src/model.js";
import { api } from "../src/api.js";
import { sessionIn } from "./fixtures.js";
import { runOf } from "./telemetry-fixtures.js";

const hoisted = vi.hoisted(() => ({
  value: null as unknown as { board: BoardState; actions: BoardActions },
}));

vi.mock("../src/store.js", () => ({
  useBoard: () => hoisted.value,
}));

vi.mock("../src/components/PollStrip.js", () => ({ PollStrip: () => null }));
vi.mock("../src/components/Counts.js", () => ({ Counts: () => null }));
vi.mock("../src/components/Board.js", () => ({ Board: () => null }));

import { App } from "../src/App.js";

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

const board = (sessions: Session[]): BoardState => {
  const state: StateResponse = { seq: 1, sessions, daemon: daemon(), capabilities: caps() };
  return { link: "open", needsPairing: false, state, results: {}, pending: {}, highlight: null };
};

const actions = (): BoardActions => ({
  restore: vi.fn(),
  ack: vi.fn(),
  dismiss: vi.fn(),
  copyCwd: vi.fn(),
  pair: vi.fn().mockResolvedValue(true),
});

const s1 = sessionIn("working", { id: "s1", callsign: "MC-03", project: "schmux", startedAt: "2026-11-08T20:00:00Z" });
const s2 = sessionIn("working", { id: "s2", callsign: "MC-04", project: "schmux", startedAt: "2026-11-08T20:10:00Z" });

/** Sets the hash first so App reads it on mount, then renders with the given sessions. */
function mountApp(sessions: Session[], hash: string): BoardActions {
  location.hash = hash;
  const a = actions();
  hoisted.value = { board: board(sessions), actions: a };
  render(<App />);
  return a;
}

beforeEach(() => {
  location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("T123 routes", () => {
  it("RO-01 #/s/s1 shows the session page with the header and no telemetry row; #/ shows the deck", async () => {
    mountApp([s1, s2], "#/");
    fireEvent.keyDown(document, { key: "t" });
    expect(screen.getByTestId("telemetry")).toBeTruthy();
    expect(screen.queryByTestId("session-view")).toBeNull();

    location.hash = "#/s/s1";
    const view = await screen.findByTestId("session-view");
    expect(view.getAttribute("data-session")).toBe("s1");
    expect(screen.getByTestId("fd-bar")).toBeTruthy();
    expect(screen.queryByTestId("telemetry")).toBeNull();

    cleanup();
    mountApp([s1, s2], "#/");
    expect(screen.queryByTestId("session-view")).toBeNull();
    expect(screen.getByTestId("app")).toBeTruthy();
  });

  it("RO-02 key o opens the selected session's page; Escape goes up one level", async () => {
    mountApp([s1, s2], "#/");
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "o" });
    expect(location.hash).toBe("#/s/s1");
    await screen.findByTestId("session-view");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(location.hash).toBe("#/");

    cleanup();
    vi.spyOn(api, "traces").mockResolvedValue({ runs: [runOf({ traceId: "t1" })] } as unknown as TracesResponse);
    mountApp([s1, s2], "#/s/s1/run/t1");
    await screen.findByTestId("run-view");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(location.hash).toBe("#/s/s1");
  });

  it("RO-03 on the session page j moves to the next session's page; l and n do nothing", async () => {
    mountApp([s1, s2], "#/s/s1");
    await screen.findByTestId("session-view");

    fireEvent.keyDown(document, { key: "j" });
    expect(location.hash).toBe("#/s/s2");
    await waitFor(() => expect(screen.getByTestId("session-view").getAttribute("data-session")).toBe("s2"));

    fireEvent.keyDown(document, { key: "l" });
    fireEvent.keyDown(document, { key: "n" });
    expect(location.hash).toBe("#/s/s2");
    expect(document.querySelector('[data-testid="list"]')).toBeNull();
  });

  it("RO-04 the run page loads the session's traces; a trace id missing from the answer shows rv-missing", async () => {
    const spy = vi
      .spyOn(api, "traces")
      .mockResolvedValue({ runs: [runOf({ traceId: "t1" })] } as unknown as TracesResponse);
    mountApp([s1, s2], "#/s/s1/run/t1");
    await waitFor(() => expect(screen.getByTestId("run-view")).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("s1");
    expect(screen.getByTestId("rv-status")).toBeTruthy();
    expect(screen.queryByTestId("rv-missing")).toBeNull();

    cleanup();
    spy.mockClear();
    mountApp([s1, s2], "#/s/s1/run/t9");
    expect(await screen.findByTestId("rv-missing")).toBeTruthy();
  });

  it("RO-05 an unknown session returns to the deck; the sheet links to the page; help lists O", async () => {
    mountApp([s1, s2], "#/s/unknown");
    await waitFor(() => expect(location.hash).toBe("#/"));
    expect(screen.queryByTestId("session-view")).toBeNull();

    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "i" });
    const link = screen.getByTestId("sheet-open");
    expect(link.getAttribute("href")).toBe("#/s/s1");

    fireEvent.keyDown(document, { key: "?" });
    expect(within(screen.getByTestId("help")).getByText("The selected session's page")).toBeTruthy();
  });
});
