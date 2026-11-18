import { expect, type Page } from "@playwright/test";
import { test } from "./support/daemon";
import { markers, openList, openPaired, showSplashdown } from "./support/page";

/** DESIGN.md section 1, the dark tokens (the default theme), copied verbatim. */
const DARK: Record<string, string> = {
  "--bg": "#0c0b0a",
  "--bg2": "#161412",
  "--card": "rgba(30,28,25,.52)",
  "--solid": "#1c1a18",
  "--card2": "rgba(30,28,26,.94)",
  "--card3": "rgba(40,37,33,.5)",
  "--hair": "rgba(236,230,218,.07)",
  "--hair2": "rgba(236,230,218,.13)",
  "--hair3": "rgba(236,230,218,.26)",
  "--ink": "#ece7dc",
  "--ink2": "#a9a398",
  "--ink3": "#8f897f",
  "--ink4": "#47433e",
  "--go": "#46cf8c",
  "--look": "#ff8a3b",
  "--go-bg": "rgba(70,207,140,.09)",
  "--look-bg": "rgba(255,138,59,.08)",
  "--look-line": "rgba(255,138,59,.4)",
  "--c-ink": "#ece7dc",
  "--c-ink2": "#a9a398",
  "--c-ink3": "#706b62",
  "--c-grid": "#ece7dc",
  "--c-go": "#46cf8c",
  "--c-look": "#ff8a3b",
  "--c-paper": "#121110",
  "--c-gridk": ".22",
  "--c-glow": "1",
  "--sans": '"Geist", ui-sans-serif, system-ui, sans-serif',
  "--mono": '"Geist Mono", ui-monospace, Consolas, monospace',
  "--r": "20px",
  "--r-hero": "24px",
  "--side": "352px",
  "--gap": "16px",
  "--tele-h": "138px",
  "--dur": "200ms",
  "--pulse": "2400ms",
};

/** DESIGN.md section 1, the light "bone" tokens (only the ones that differ). */
const LIGHT: Record<string, string> = {
  "--bg": "#e7e2d5",
  "--bg2": "#efebe1",
  "--card": "rgba(250,248,242,.62)",
  "--solid": "#f8f5ee",
  "--card2": "rgba(252,251,247,.9)",
  "--card3": "rgba(236,231,219,.55)",
  "--hair": "rgba(28,30,32,.10)",
  "--hair2": "rgba(28,30,32,.18)",
  "--hair3": "rgba(28,30,32,.32)",
  "--ink": "#1b1d1f",
  "--ink2": "#4c4d4c",
  "--ink3": "#6b675e",
  "--ink4": "#b2ac9e",
  "--go": "#1a6a43",
  "--look": "#9c4209",
  "--go-bg": "rgba(26,106,67,.09)",
  "--look-bg": "rgba(156,66,9,.08)",
  "--look-line": "rgba(156,66,9,.38)",
  "--c-ink": "#1b1d1f",
  "--c-ink2": "#4c4d4c",
  "--c-ink3": "#857f72",
  "--c-grid": "#2a2724",
  "--c-go": "#1a6a43",
  "--c-look": "#b34d0b",
  "--c-paper": "#f3efe6",
  "--c-gridk": ".30",
  "--c-glow": ".55",
};

/** Frozen clock for DS-08: 2026-11-08 20:41:07 local, the DESIGN.md 10 fixture time. */
const FIXED = new Date("2026-11-08T20:41:07");

/**
 * Canonical spelling of a token value, so equal values compare equal: whitespace, case,
 * a leading zero on decimals (".08em" is "0.08em"), trailing decimal zeros (".10" is "0.1")
 * and seconds as milliseconds ("1s" is "1000ms").
 */
function canon(v: string): string {
  return v
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .toLowerCase()
    .replace(/(^|[^\d.])\.(\d)/g, "$10.$2")
    .replace(/(\.\d*?[1-9])0+(?!\d)/g, "$1")
    .replace(/(\d*\.?\d+)s\b/g, (_m, n: string) => `${Math.round(parseFloat(n) * 1000)}ms`);
}

async function tokenMismatches(page: Page, want: Record<string, string>): Promise<string[]> {
  const actual = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
  }, Object.keys(want));
  return Object.entries(want)
    .filter(([name, v]) => canon(actual[name] ?? "") !== canon(v))
    .map(([name, v]) => `${name}: want "${v}" got "${actual[name] ?? ""}"`);
}

test("DS-01 computed :root custom properties equal the DESIGN.md tokens, dark by default and light by preference or toggle", async ({ page, mc }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openPaired(page, mc);
  expect(await tokenMismatches(page, DARK)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await tokenMismatches(page, LIGHT)).toEqual([]);
  // The theme button overrides the preference both ways and remembers the choice.
  await page.getByTestId("btn-theme").click();
  expect(await tokenMismatches(page, DARK)).toEqual([]);
  await page.reload();
  await expect(page.getByTestId("fd-bar")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.getByTestId("btn-theme").click();
  expect(await tokenMismatches(page, LIGHT)).toEqual([]);
});

test("DS-02 Geist 200, 300, 400, 500 and Geist Mono 400, 500 are self-hosted and loaded", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.seedBoard();
  await expect(page.getByTestId("needs-card").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => {
    const faces = [...document.fonts].filter((f) => f.status === "loaded");
    const has = (family: string, weight: string): boolean =>
      faces.some((f) => f.family.replace(/["']/g, "") === family && String(f.weight) === weight);
    return {
      geist: ["200", "300", "400", "500"].map((w) => has("Geist", w)),
      mono: ["400", "500"].map((w) => has("Geist Mono", w)),
      check: document.fonts.check('200 16px "Geist"') && document.fonts.check('500 16px "Geist Mono"'),
    };
  });
  expect(loaded).toEqual({ geist: [true, true, true, true], mono: [true, true], check: true });
});

test("DS-03 two signal colours only: look states are orange, working and idle green, the rest uncoloured, and no other hue on the page", async ({ page, mc }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openPaired(page, mc);
  await mc.seedBoard();
  await showSplashdown(page, 2);
  await expect(page.getByTestId("card")).toHaveCount(9);
  const rows = await page.getByTestId("card").evaluateAll((els) =>
    els.map((e) => {
      const pill = e.querySelector('[data-testid="state-label"]') as HTMLElement;
      return { state: e.getAttribute("data-state") ?? "", label: pill.textContent ?? "", color: getComputedStyle(pill).color };
    }),
  );
  const LOOK = "rgb(255, 138, 59)";
  const GO = "rgb(70, 207, 140)";
  const INK2 = "rgb(169, 163, 152)";
  const want: Record<string, string> = {
    "Needs permission": LOOK,
    "Needs input": LOOK,
    Error: LOOK,
    Done: LOOK,
    Working: GO,
    Idle: GO,
    Starting: INK2,
    Ended: INK2,
    Lost: INK2,
  };
  expect(rows.map((r) => r.label).sort()).toEqual(Object.keys(want).sort());
  for (const r of rows) expect(r.color, `${r.state} (${r.label})`).toBe(want[r.label]);

  // Every coloured pixel source on the page is go or look; everything else is warm neutral.
  for (const view of ["list", "deck"] as const) {
    if (view === "deck") await page.keyboard.press("l");
    const hues = await page.evaluate(() => {
      const out = new Set<string>();
      const props = ["color", "background-color", "border-top-color", "border-left-color", "outline-color"] as const;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        for (const p of props) {
          const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(cs.getPropertyValue(p));
          if (!m) continue;
          const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const a = m[4] === undefined ? 1 : Number(m[4]);
          if (a === 0) continue;
          if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.25) out.add(`${r},${g},${b}`);
        }
      }
      return [...out].sort();
    });
    for (const h of hues) expect(["255,138,59", "70,207,140"], `${view}: hue ${h}`).toContain(h);
  }
});

test("DS-04 an unacknowledged permission pulses its dot; acknowledged has no animation", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ds04" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "ds04" });
  const card = page.getByTestId("needs-card");
  await expect(card).toHaveAttribute("data-state", "needs_permission");
  const running = () => card.evaluate((el) => el.getAnimations({ subtree: true }).some((a) => a.playState === "running"));
  await expect.poll(running).toBe(true);
  await card.getByTestId("more").click();
  await card.getByTestId("ack").click();
  await expect(card).toHaveAttribute("data-attention", "acked");
  await expect.poll(running).toBe(false);
});

test("DS-05 with reduced motion there are zero running animations and items that need you keep a 2px outline", async ({ page, mc }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ds05" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "ds05" });
  const card = page.getByTestId("needs-card");
  await expect(card).toHaveAttribute("data-state", "needs_permission");
  await page.keyboard.press("n");
  await expect(page.getByTestId("selected")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(card).toHaveCSS("outline-width", "2px");
  await expect(card).toHaveCSS("outline-style", "solid");
});

test("DS-06 the deck layout: 352px side column, the terrain fills the rest; no telemetry row until T, then four 138px cards in a row (two below 1180px)", async ({ page, mc }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPaired(page, mc);
  await mc.seedBoard();
  await expect(page.getByTestId("needs-card")).toHaveCount(3);
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const side = await box(".side");
  const full = await box('[data-testid="board"]');
  expect(side.x).toBeCloseTo(24, 0);
  expect(side.width).toBeCloseTo(352, 0);
  expect(full.x - (side.x + side.width)).toBeCloseTo(16, 0);
  expect(full.x + full.width).toBeCloseTo(1440 - 24, 0);
  // D-61: no session on this board reports telemetry, so no telemetry row and the terrain takes its height.
  await expect(page.getByTestId("telemetry")).toHaveCount(0);
  expect(full.height).toBeGreaterThan(700);
  // T shows the row anyway, with "No data" cards.
  await page.locator("body").click({ position: { x: 5, y: 890 } });
  await page.keyboard.press("t");
  await expect(page.getByTestId("telemetry")).toBeVisible();
  const hero = await box('[data-testid="board"]');
  const tele = await page.locator(".tc").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(hero.height).toBeGreaterThan(560);
  expect(tele).toHaveLength(4);
  for (const t of tele) {
    expect(t.top).toBeCloseTo(tele[0]!.top, 0);
    expect(t.height).toBeCloseTo(138, 0);
    expect(t.width).toBeCloseTo(tele[0]!.width, 0);
  }
  expect(tele[0]!.top - (hero.y + hero.height)).toBeCloseTo(16, 0);
  expect(tele[3]!.right).toBeCloseTo(1440 - 24, 0);
  // At most three Needs you cards, then "+N more"; four sessions need you on this board.
  await expect(page.getByTestId("poll-more")).toHaveText("+1 more in the list");
  // Header: 40px high, telemetry at the bottom edge with a 20px margin; no page scroll at 1440x900.
  expect((await box('[data-testid="fd-bar"]')).height).toBeCloseTo(40, 0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  await page.setViewportSize({ width: 1100, height: 900 });
  const cols = await page.locator(".tele").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(2);
});

test("DS-07 typography: Geist for words, Geist Mono for callsigns and times, a 200-weight readiness number, nothing upper-cased", async ({ page, mc }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPaired(page, mc);
  await mc.seedBoard();
  await expect(page.getByTestId("needs-card")).toHaveCount(3);
  const t = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel) as Element);
    const upper: string[] = [];
    const families = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
      if (!own) continue;
      const c = getComputedStyle(el);
      if (c.textTransform === "uppercase") upper.push(el.getAttribute("data-testid") ?? el.tagName);
      families.add(c.fontFamily.split(",")[0]!.replace(/["']/g, "").trim());
    }
    return {
      body: cs("body").fontFamily.split(",")[0]!.replace(/["']/g, "").trim(),
      callsign: cs('[data-testid="needs-card"] [data-testid="callsign"]').fontFamily.split(",")[0]!.replace(/["']/g, "").trim(),
      clock: cs('[data-testid="fd-met"]').fontFamily.split(",")[0]!.replace(/["']/g, "").trim(),
      waited: cs('[data-testid="waited"]').fontVariantNumeric,
      ready: { weight: cs('[data-testid="readiness"]').fontWeight, size: cs('[data-testid="readiness"]').fontSize },
      upper,
      families: [...families].sort(),
    };
  });
  expect(t.body).toBe("Geist");
  expect(t.callsign).toBe("Geist Mono");
  expect(t.clock).toBe("Geist Mono");
  expect(t.waited).toContain("tabular-nums");
  expect(t.ready).toEqual({ weight: "200", size: "68px" });
  expect(t.upper).toEqual([]);
  expect(t.families).toEqual(["Geist", "Geist Mono"]);
});

test("DS-08 fixture board screenshot matches board-<platform>.png within 1%", async ({ page, mc }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install({ time: FIXED });
  await page.clock.setFixedTime(FIXED);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  // Event times sit on the frozen clock, so waits and up times are fixed values.
  mc.anchor = FIXED.getTime() - 120_000;
  await openPaired(page, mc);
  await mc.seedBoard();
  // The lost row is set by the liveness sweeper (one 5 s pass after seeding).
  await showSplashdown(page, 2);
  await page.keyboard.press("l");
  await expect(page.getByTestId("list")).toHaveCount(0);
  // Select the longest-waiting session, as the approved concept shows it.
  await page.keyboard.press("n");
  await expect(page.getByTestId("selected")).toBeVisible();
  // The other three that need you carry pills over their peaks.
  await expect(page.locator('[data-testid="callout"]:visible')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("board.png", {
    maxDiffPixelRatio: 0.01,
    // The ended and lost sessions carry real-clock times (SessionEnd, and a session started
    // 13 h ago), which the frozen browser clock cannot line up with, so their dock entries are masked.
    // The host name is the machine's own, so it is masked too.
    mask: [
      page.getByTestId("fd-host"),
      page.locator('[data-testid="dock"] li[data-state="ended"]'),
      page.locator('[data-testid="dock"] li[data-state="lost"]'),
    ],
  });
});

test("DS-09 empty board says No sessions yet and how to install the hooks", async ({ page, mc }) => {
  await openPaired(page, mc);
  const empty = page.getByTestId("empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No sessions yet");
  await expect(empty).toContainText("mc init");
  await expect(page.getByTestId("all-clear")).toBeVisible();
  await expect(page.getByTestId("readiness-line")).toHaveText("No live sessions");
  // D-61: no telemetry row until a session reports telemetry.
  await expect(page.getByTestId("telemetry")).toHaveCount(0);
});

test("DS-10 the page makes no request to any origin other than the daemon and logs no errors", async ({ page, mc }) => {
  const urls: string[] = [];
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => urls.push(r.url()));
  page.on("websocket", (ws) => urls.push(ws.url()));
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "ds10" });
  await openList(page);
  await expect(page.getByTestId("card")).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const own = [`http://127.0.0.1:${mc.port}`, `ws://127.0.0.1:${mc.port}`];
  const foreign = urls.filter(
    (u) => !own.some((o) => u === o || u.startsWith(`${o}/`)) && !u.startsWith("data:") && !u.startsWith("blob:"),
  );
  expect(urls.length).toBeGreaterThan(0);
  expect(foreign).toEqual([]);
  // The one expected error is the browser logging the 401 of /api/state before pairing.
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("TR-01 dragging the terrain orbits inside the card and never scrolls the page; the wheel zooms instead of scrolling", async ({ page, mc }) => {
  // A short viewport makes the page itself scrollable (min-height 800px).
  await page.setViewportSize({ width: 1280, height: 700 });
  await openPaired(page, mc);
  await mc.seedBoard();
  await expect(page.getByTestId("needs-card").first()).toBeVisible();
  const canvas = page.getByTestId("terrain");
  await expect(canvas).toHaveCSS("touch-action", "none");
  await expect(page.getByTestId("board")).toHaveCSS("touch-action", "none");
  await expect(page.getByTestId("reset-view")).toHaveAttribute("data-off", "true");
  const box = (await canvas.boundingBox())!;
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
  expect(scrollable).toBe(true);
  const before = await markers(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + Math.min(box.height / 2, 300);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 20, cy - i * 12);
  await page.mouse.up();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByTestId("reset-view")).toHaveAttribute("data-off", "false");
  await expect.poll(async () => {
    const after = await markers(page);
    const a = after.find((m) => m.id === before[0]!.id)!;
    return Math.hypot(a.x - before[0]!.x, a.y - before[0]!.y);
  }).toBeGreaterThan(5);
  // A drag is not a click: nothing got selected.
  await expect(page.getByTestId("selected")).toHaveCount(0);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Reset brings the view home.
  await page.getByTestId("reset-view").click();
  await expect(page.getByTestId("reset-view")).toHaveAttribute("data-off", "true");
});

test("TR-02 a still click on a peak selects that session and a click on empty ground deselects", async ({ page, mc }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "tr02" });
  await mc.send("UserPromptSubmit", { prompt: "Work" }, { session: "tr02" });
  await expect.poll(async () => (await markers(page)).length).toBe(1);
  const [m] = await markers(page);
  await page.mouse.click(m!.x, m!.y);
  const sel = page.getByTestId("selected");
  await expect(sel).toBeVisible();
  await expect(sel).toContainText("MC-01");
  await expect(sel).toContainText("Working");
  await expect(page.getByTestId("reset-view")).toHaveAttribute("data-off", "true");
  const box = (await page.getByTestId("terrain").boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height - 140);
  await expect(sel).toHaveCount(0);
});

test("TR-03 the list view holds every session, with ended and lost grouped and collapsible", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.seedBoard();
  await page.keyboard.press("l");
  await expect(page.getByTestId("list")).toBeVisible();
  await expect(page.getByTestId("terrain")).toBeHidden();
  // The lost row only leaves the live rows after the 5 s liveness sweep (as in showSplashdown).
  await expect(page.getByTestId("card")).toHaveCount(7, { timeout: 15_000 });
  await showSplashdown(page, 2);
  const shown = await page.getByTestId("card").getByTestId("callsign").allTextContents();
  expect(shown).toHaveLength(9);
  expect(new Set(shown).size).toBe(9);
  await page.getByTestId("splashdown-toggle").click();
  await expect(page.getByTestId("card")).toHaveCount(7);
  // "+1 more in the list" opens the same list; L closes it again.
  await page.keyboard.press("l");
  await expect(page.getByTestId("list")).toHaveCount(0);
  await page.getByTestId("poll-more").click();
  await expect(page.getByTestId("list")).toBeVisible();
});

test("TR-04 the keyboard map: N selects who needs you, Enter restores, A acknowledges, I opens details, Esc steps back, ? shows help", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "tr04a" });
  await mc.send("UserPromptSubmit", { prompt: "Work" }, { session: "tr04a" });
  await mc.send("SessionStart", { source: "startup" }, { session: "tr04b" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "tr04b" });
  await expect(page.getByTestId("needs-card")).toHaveCount(1);
  await page.keyboard.press("j");
  await expect(page.getByTestId("selected")).toContainText("MC-01");
  await page.keyboard.press("n");
  await expect(page.getByTestId("selected")).toContainText("MC-02");
  await expect(page.getByTestId("needs-card")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("a");
  await expect(page.getByTestId("needs-card")).toHaveAttribute("data-attention", "acked");
  await page.keyboard.press("Enter");
  await expect.poll(() => mc.countCalls("focus")).toBe(1);
  await page.keyboard.press("i");
  await expect(page.getByTestId("sheet")).toContainText("MC-02");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sheet")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selected")).toHaveCount(0);
  await page.keyboard.press("r");
  await expect(page.getByTestId("readiness-pop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("readiness-pop")).toHaveCount(0);
  await page.keyboard.press("t");
  await expect(page.getByTestId("telemetry")).toHaveAttribute("data-mode", "wait");
  await expect(page.locator(".tc .pill").first()).toHaveText("No data");
  await page.keyboard.press("?");
  await expect(page.getByTestId("help")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help")).toHaveCount(0);
});
