import { expect, type Locator, type Page } from "@playwright/test";
import type { Mc } from "./events";

/** Pairs the page with the daemon through the typed code (D-05), then waits for the header. */
export async function openPaired(page: Page, mc: Mc): Promise<void> {
  const code = await mc.pairCode();
  await page.goto(`http://127.0.0.1:${mc.port}/`);
  await page.getByTestId("pair-input").fill(code);
  await page.getByTestId("pair-submit").click();
  await expect(page.getByTestId("fd-bar")).toBeVisible();
  await expect(page.getByTestId("banner")).toHaveCount(0);
}

/**
 * Opens the list view (key L, DESIGN.md 3): every session as a row. Rows carry
 * data-testid="card" and the per-session test ids (callsign, state-label, restore, ...).
 */
export async function openList(page: Page): Promise<void> {
  const list = page.getByTestId("list");
  if ((await list.count()) === 0) await page.getByTestId("btn-list").click();
  await expect(list).toBeVisible();
}

/** The list row whose callsign is `callsign` (MC-01, MC-02, ...). */
export function cardFor(page: Page, callsign: string): Locator {
  return page.getByTestId("card").filter({
    has: page.getByTestId("callsign").getByText(callsign, { exact: true }),
  });
}

/**
 * Ended and lost sessions sit in the list's collapsed "Ended and lost" group (DESIGN.md 3).
 * Opens the list, waits until the group exists, expands it and waits for `count` rows.
 */
export async function showSplashdown(page: Page, count: number): Promise<void> {
  await openList(page);
  const splash = page.getByTestId("splashdown");
  const toggle = page.getByTestId("splashdown-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle).toContainText(/Show|Hide/);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(splash.getByTestId("card")).toHaveCount(count, { timeout: 15_000 });
}

/** Where the terrain draws each session's peak, in page coordinates. */
export async function markers(page: Page): Promise<{ id: string; x: number; y: number }[]> {
  return page.getByTestId("terrain").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const list = (el as HTMLCanvasElement & { mcMarkers?: { id: string; x: number; y: number }[] }).mcMarkers ?? [];
    return list.map((m) => ({ id: m.id, x: r.left + m.x, y: r.top + m.y }));
  });
}
