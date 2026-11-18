import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@mc/contracts";
import { ListView } from "../src/components/ListView.js";
import type { BoardActions, BoardState, DeckActions } from "../src/model.js";
import { sessionIn } from "./fixtures.js";
import { telemetryOf } from "./telemetry-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Same clock as card.test.tsx: 01:01:12 after the fixtures' startedAt.
const NOW = Date.parse("2026-11-12T09:01:12.000Z");

const mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

type Spy = ReturnType<typeof vi.fn>;

function mount(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(node));
  return host;
}

function board(): BoardState {
  return { link: "open", needsPairing: false, state: null, results: {}, pending: {}, highlight: null };
}

function renderList(sessions: Session[]) {
  const actions = { restore: vi.fn(), ack: vi.fn(), dismiss: vi.fn(), copyCwd: vi.fn(), pair: vi.fn(async () => true) } as BoardActions;
  const deck = { select: vi.fn(), details: vi.fn(), dismissAlert: vi.fn(), copy: vi.fn(), toggleMenu: vi.fn() } as DeckActions & {
    select: Spy;
  };
  const host = mount(
    <ListView
      sessions={sessions}
      board={board()}
      dismissed={{}}
      now={NOW}
      selected={null}
      showEnded={true}
      onToggleEnded={() => undefined}
      actions={actions}
      deck={deck}
    />,
  );
  return { host, deck };
}

const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('tr[data-testid="card"]')];
const idsOf = (host: HTMLElement): string[] => rows(host).map((r) => r.dataset["session"] ?? "");
const cell = (host: HTMLElement, id: string, testid: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`tr[data-session="${id}"] [data-testid="${testid}"]`);
const press = (el: HTMLElement | null): void => {
  if (el === null) throw new Error("missing element");
  act(() => el.click());
};
const headerLine = (host: HTMLElement): string => host.querySelector("h2 span")?.textContent ?? "";

const quiet = { attention: { active: false } } as const;

function telemetrySessions(): Session[] {
  return [
    sessionIn("working", {
      ...quiet,
      id: "a",
      callsign: "alpha",
      telemetry: telemetryOf({
        credits: { aiCredits: 12.35, nanoAiu: null },
        tokenRate: 1234,
        context: { estimatePct: 42 },
        permissions: { waitedMs: 72_000 },
        tools: [{ name: "bash", runs: 5, failed: 2, p50Ms: null, maxMs: null }],
      }),
    }),
    sessionIn("working", {
      ...quiet,
      id: "b",
      callsign: "bravo",
      telemetry: telemetryOf({
        credits: { aiCredits: 3, nanoAiu: null },
        tokenRate: 10,
        context: { estimatePct: 10 },
        permissions: { waitedMs: 1000 },
        tools: [],
      }),
    }),
    sessionIn("working", { ...quiet, id: "sh", callsign: "shell", adapter: "shell", telemetry: null }),
  ];
}

describe("list view telemetry columns", () => {
  it("LS-01 five cells show formatted values; a session without telemetry shows n/a", () => {
    const { host } = renderList(telemetrySessions());
    const a = "a";
    expect(cell(host, a, "t-credits")?.textContent).toContain("12.35");
    expect(cell(host, a, "t-credits")?.textContent).toContain("AI Credits");
    expect(cell(host, a, "t-rate")?.textContent).toBe("1,234");
    expect(cell(host, a, "t-ctx")?.textContent).toContain("≈42%");
    expect(cell(host, a, "t-waited")?.textContent).toBe("01:12");
    expect(cell(host, a, "t-failed")?.textContent).toBe("2");
    for (const key of ["credits", "rate", "ctx", "waited", "failed"]) {
      const el = cell(host, "sh", `t-${key}`);
      expect(el?.textContent).toBe("n/a");
      expect(el?.classList.contains("na")).toBe(true);
    }
  });

  it("LS-02 sort-credits cycles desc, asc, default; no-telemetry row last both ways; header line follows", () => {
    const { host } = renderList(telemetrySessions());
    const defaultOrder = idsOf(host);
    expect(headerLine(host)).toContain("sorted by who needs you");

    const btn = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="sort-credits"]');
    const th = (): string | null => btn()?.closest("th")?.getAttribute("aria-sort") ?? null;

    press(btn());
    expect(idsOf(host)).toEqual(["a", "b", "sh"]);
    expect(th()).toBe("descending");
    expect(headerLine(host)).toContain("sorted by Credits ↓");

    press(btn());
    expect(idsOf(host)).toEqual(["b", "a", "sh"]);
    expect(th()).toBe("ascending");
    expect(headerLine(host)).toContain("sorted by Credits ↑");

    press(btn());
    expect(idsOf(host)).toEqual(defaultOrder);
    expect(th()).toBe("none");
    expect(headerLine(host)).toContain("sorted by who needs you");
  });

  it("LS-03 context above 85 sets data-over on t-ctx; failed tools above 0 set it on t-failed", () => {
    const over = renderList([
      sessionIn("working", { ...quiet, id: "hot", telemetry: telemetryOf({ context: { estimatePct: 86 } }) }),
    ]);
    expect(cell(over.host, "hot", "t-ctx")?.dataset["over"]).toBe("true");
    expect(cell(over.host, "hot", "t-ctx")?.textContent).toContain("Over 85%");

    const under = renderList([
      sessionIn("working", { ...quiet, id: "cool", telemetry: telemetryOf({ context: { estimatePct: 85 } }) }),
    ]);
    expect(cell(under.host, "cool", "t-ctx")?.dataset["over"]).toBeUndefined();

    const failing = renderList([
      sessionIn("working", {
        ...quiet,
        id: "f",
        telemetry: telemetryOf({ tools: [{ name: "bash", runs: 3, failed: 1, p50Ms: null, maxMs: null }] }),
      }),
    ]);
    expect(cell(failing.host, "f", "t-failed")?.dataset["over"]).toBe("true");
  });

  it("LS-04 a live row has open-session linking to its page; an ended row has none; clicking it does not select", () => {
    const { host, deck } = renderList([
      sessionIn("working", { ...quiet, id: "s/1 x" }),
      sessionIn("ended", { id: "gone" }),
    ]);
    const open = host.querySelector<HTMLAnchorElement>('tr[data-session="s/1 x"] [data-testid="open-session"]');
    expect(open?.getAttribute("href")).toBe(`#/s/${encodeURIComponent("s/1 x")}`);
    expect(host.querySelector('tr[data-session="gone"] [data-testid="open-session"]')).toBeNull();

    press(open);
    expect(deck.select).not.toHaveBeenCalled();
  });
});
