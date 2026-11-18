import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Empty } from "../src/components/Empty.js";
import { layoutRegions, onMap, overviewDistance, reliefRise } from "../src/terrain.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, "0")}`);

describe("terrain fit (T105, D-51)", () => {
  it("TV-01 ended sessions leave the map; lost and every live state stay", () => {
    expect(onMap({ state: "ended" })).toBe(false);
    for (const state of ["lost", "starting", "working", "idle", "needs_permission", "needs_input", "error"]) {
      expect(onMap({ state }), state).toBe(true);
    }
  });

  it("TV-02 the overview distance keeps 640 for one region and 800 up to the 2x2 layout, and grows to fit more", () => {
    expect(overviewDistance(layoutRegions(ids(1)))).toBe(640);
    for (const n of [2, 3, 4]) expect(overviewDistance(layoutRegions(ids(n))), String(n)).toBe(800);
    let last = 800;
    for (const n of [9, 15, 25]) {
      const d = overviewDistance(layoutRegions(ids(n)));
      expect(d, String(n)).toBeGreaterThan(800);
      expect(d, String(n)).toBeGreaterThanOrEqual(last);
      expect(d, String(n)).toBeLessThanOrEqual(1400);
      last = d;
    }
  });

  it("TV-04 the 2x2 layout and fewer keep the concept's pads; more pads leave a rolling margin inside the 400-unit world", () => {
    const two = layoutRegions(ids(4));
    expect(two.map((r) => [r.cx, r.cz, r.hw, r.hd])).toEqual([
      [-140, -100, 112, 84],
      [140, -100, 112, 84],
      [-140, 100, 112, 84],
      [140, 100, 112, 84],
    ]);
    for (const n of [5, 10, 15, 25]) {
      const rs = layoutRegions(ids(n));
      const ex = Math.max(...rs.map((r) => Math.abs(r.cx) + r.hw));
      const ez = Math.max(...rs.map((r) => Math.abs(r.cz) + r.hd));
      expect(ex, String(n)).toBeLessThanOrEqual(300);
      expect(ez, String(n)).toBeLessThanOrEqual(220);
    }
  });

  it("TV-05 the relief ramp is 70 up to four pads and follows the narrowest gap past that, never under 14", () => {
    for (const n of [1, 2, 4]) expect(reliefRise(layoutRegions(ids(n))), String(n)).toBe(70);
    for (const n of [5, 10, 15, 25]) {
      const r = reliefRise(layoutRegions(ids(n)));
      expect(r, String(n)).toBeGreaterThanOrEqual(14);
      expect(r, String(n)).toBeLessThan(70);
    }
  });

  it("TV-03 the empty note gives mc init, or points at the list when only ended sessions remain", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<Empty />));
    expect(host.textContent).toContain("No sessions yet");
    expect(host.textContent).toContain("mc init");
    expect(host.textContent).not.toContain("mc install claude-code");
    act(() => root.render(<Empty ended={3} />));
    expect(host.textContent).toContain("No live sessions");
    expect(host.textContent).toContain("3 ended sessions are in the list");
    act(() => root.unmount());
  });
});
