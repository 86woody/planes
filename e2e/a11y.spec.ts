import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/daemon";
import { openList, openPaired, showSplashdown } from "./support/page";

async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((a) => a.message).join("; ")}`).join(" | ")}`);
}

test("AX-01 axe finds no serious or critical violations on the deck and the list, dark and light, with all states", async ({ page, mc }) => {
  // Scan the steady treatments: under reduced motion nothing pulses (DESIGN.md 7).
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await openPaired(page, mc);
  await mc.seedBoard();
  await expect(page.getByTestId("needs-card").first()).toBeVisible();
  await page.keyboard.press("n"); // a selected session card over the terrain
  await expect(page.getByTestId("selected")).toBeVisible();
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: scheme });
    expect(await seriousViolations(page), `deck, ${scheme}`).toEqual([]);
  }
  await showSplashdown(page, 2);
  await expect(page.getByTestId("card")).toHaveCount(9);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: scheme });
    expect(await seriousViolations(page), `list, ${scheme}`).toEqual([]);
  }
});

test("AX-02 in the list, Tab reaches every Restore and Acknowledge in row order and Enter restores", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ax02a" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "ax02a" });
  await mc.send("SessionStart", { source: "startup" }, { session: "ax02b" });
  await mc.send("Notification", { notification_type: "idle_prompt", message: "Waiting" }, { session: "ax02b" });
  await openList(page);
  await expect(page.getByTestId("card")).toHaveCount(2);

  // Row order: the DOM order of the buttons the list renders for rows.
  const expected = await page
    .locator('[data-testid="card"] [data-testid="restore"]:not([disabled]), [data-testid="card"] [data-testid="ack"]')
    .evaluateAll((els) => els.map((e) => `${e.closest('[data-testid="card"]')?.getAttribute("data-session")} ${e.getAttribute("data-testid")}`));
  expect(expected.length).toBeGreaterThanOrEqual(4);

  const reached: string[] = [];
  const outlines: string[] = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      // Focus has left the page (body) once the sweep has gone through every control.
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const row = el.closest('[data-testid="card"]');
      return {
        key: `${row?.getAttribute("data-session") ?? ""} ${el.getAttribute("data-testid") ?? ""}`,
        inRow: row !== null,
        testid: el.getAttribute("data-testid"),
        outline: `${cs.outlineWidth} ${cs.outlineStyle}`,
      };
    });
    if (info === null) break;
    if (info.inRow && (info.testid === "restore" || info.testid === "ack")) {
      reached.push(info.key);
      outlines.push(info.outline);
    }
  }
  expect(reached).toEqual(expected);
  for (const o of outlines) expect(o).toBe("2px solid");

  // Enter on a focused Restore sends the focus call.
  await page.getByTestId("card").getByTestId("restore").first().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => mc.countCalls("focus")).toBe(1);
});

test("AX-03 every focused control on the deck shows a 2px outline", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ax03" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "ax03" });
  await expect(page.getByTestId("needs-card")).toHaveAttribute("data-state", "needs_permission");
  // Start the Tab sweep from the top of the page (pairing left focus on a removed form).
  await page.mouse.click(2, 2);
  const seen: { id: string; outline: string }[] = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { id: el.getAttribute("data-testid") ?? el.tagName, outline: cs.outlineWidth };
    });
    if (info === null) break;
    if (!seen.some((s) => s.id === info.id)) seen.push(info);
  }
  const ids = seen.map((s) => s.id);
  for (const want of ["btn-list", "readiness-details", "restore", "more", "terrain", "reset-view"]) expect(ids).toContain(want);
  for (const s of seen) expect(s.outline, s.id).toBe("2px");
});

test("AX-04 a new permission attention is announced in the assertive live region", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ax04" });
  const announcer = page.getByTestId("announcer");
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "ax04" });
  await expect(page.getByTestId("needs-card")).toHaveAttribute("data-state", "needs_permission");
  await expect(announcer).toContainText("MC-01");
  await expect(announcer).toContainText("Needs permission");
  await expect(announcer).toHaveAttribute("aria-live", "assertive");
  // Plain words on the page: no mission wording anywhere (D-48 4).
  await openList(page);
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/GO\/NO-GO|ASCENT|NOMINAL|ANOMALY|SPLASHDOWN|T-MINUS|MECO|\bHOLD\b|\bLOS\b/);
});
