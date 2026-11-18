import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "../src/layout.js";
import { chooseTab, focusResultFor, planFocus } from "../src/windows/focus.js";

const OPTS_ALT = { maximize: "always", foregroundStrategy: "alt-key" } as const;
const NOW = "2026-11-12T00:00:00.000Z";

describe("windows focus plan and mapping (pure)", () => {
  it("WU-07 planFocus always: maximize, alt-key, foreground, verify", () => {
    const steps = planFocus({ isWindow: true, isIconic: false, elevated: false }, OPTS_ALT);
    expect(steps.slice(0, 4)).toEqual([
      { kind: "show", cmd: 3 },
      { kind: "alt-key" },
      { kind: "foreground" },
      { kind: "verify" },
    ]);
  });

  it("WU-08 planFocus if-minimized on a non-minimized window: SW_SHOW only", () => {
    const steps = planFocus(
      { isWindow: true, isIconic: false, elevated: false },
      { maximize: "if-minimized", foregroundStrategy: "alt-key" },
    );
    expect(steps.filter((s) => s.kind === "show")).toEqual([{ kind: "show", cmd: 5 }]);
  });

  it("WU-09 planFocus never on a minimized window: SW_RESTORE", () => {
    const steps = planFocus(
      { isWindow: true, isIconic: true, elevated: false },
      { maximize: "never", foregroundStrategy: "plain" },
    );
    expect(steps.filter((s) => s.kind === "show")).toEqual([{ kind: "show", cmd: 9 }]);
    expect(steps.some((s) => s.kind === "alt-key")).toBe(false);
  });

  it("WU-10 planFocus on a missing window: not_found; on an elevated window: permission_denied", () => {
    const missing = planFocus({ isWindow: false, isIconic: false, elevated: false }, OPTS_ALT);
    expect(missing).toEqual([{ kind: "abort", code: "not_found", detail: "window does not exist" }]);
    const elevated = planFocus({ isWindow: true, isIconic: false, elevated: true }, OPTS_ALT);
    expect(elevated).toEqual([
      { kind: "abort", code: "permission_denied", detail: "target window is elevated" },
    ]);
  });

  it("WU-11 chooseTab: one tab -> 0; one claude glyph tab among three -> its index; two -> null", () => {
    expect(chooseTab([{ index: 0, name: "PowerShell" }])).toBe(0);
    const three = [
      { index: 0, name: "PowerShell" },
      { index: 1, name: "✳ Claude Code" },
      { index: 2, name: "bash" },
    ];
    expect(chooseTab(three)).toBe(1);
    const two = [
      { index: 0, name: "✳ Claude Code" },
      { index: 1, name: "✢ working on claude tests" },
      { index: 2, name: "bash" },
    ];
    expect(chooseTab(two)).toBeNull();
  });

  it("WU-19 chooseTab matches Copilot and Codex tab titles; two agent tabs stay ambiguous (D-54)", () => {
    const copilot = [
      { index: 0, name: "PowerShell" },
      { index: 1, name: "Single Word Response - GitHub Copilot" },
      { index: 2, name: "bash" },
    ];
    expect(chooseTab(copilot)).toBe(1);
    expect(chooseTab([{ index: 0, name: "pwsh" }, { index: 1, name: "codex" }])).toBe(1);
    const both = [
      { index: 0, name: "✳ Claude Code" },
      { index: 1, name: "Fix tests - GitHub Copilot" },
    ];
    expect(chooseTab(both)).toBeNull();
  });

  it("WU-20 wt-select-tab.ps1 skips Select() on an already selected tab and gives focus to the visible terminal (D-54)", () => {
    const ps = readFileSync(path.join(layout().psDir, "wt-select-tab.ps1"), "utf8");
    expect(ps).toMatch(/if \(-not \$pat\.Current\.IsSelected\)\s*\{\s*\$pat\.Select\(\)/);
    expect(ps).toContain("'TermControl'");
    expect(ps).toMatch(/-not \$t\.Current\.IsOffscreen[\s\S]*\$t\.SetFocus\(\)/);
  });

  it("WU-12 focus result mapping: verified -> focused, tab failure -> focused_window_only, verify fails twice -> flashed", () => {
    expect(focusResultFor({ foreground: true, tab: "ok" }, NOW)).toMatchObject({
      status: "ok",
      code: "focused",
    });
    expect(focusResultFor({ foreground: true, tab: "none" }, NOW)).toMatchObject({
      status: "ok",
      code: "focused",
    });
    expect(focusResultFor({ foreground: true, tab: "failed" }, NOW)).toMatchObject({
      status: "partial",
      code: "focused_window_only",
    });
    expect(focusResultFor({ foreground: false, tab: "none" }, NOW)).toMatchObject({
      status: "partial",
      code: "flashed",
    });
  });
});
