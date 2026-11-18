import { expect } from "@playwright/test";
import { test } from "./support/daemon";
import { BRANCH, PROJECT_NAME } from "./support/events";
import { cardFor, openList, openPaired } from "./support/page";

test("CARD-01 a list row shows callsign, project, branch, host, state, up time, last event and restore capability", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "card01" });
  await mc.send("UserPromptSubmit", { prompt: "Show the card" }, { session: "card01" });
  const card = cardFor(page, "MC-01");
  await expect(card.getByTestId("callsign")).toHaveText("MC-01");
  await expect(card.getByTestId("project")).toHaveText(PROJECT_NAME);
  await expect(card.getByTestId("branch")).toHaveText(BRANCH);
  await expect(card.getByTestId("host")).toHaveText("Windows Terminal");
  await expect(card.getByTestId("state-label")).toHaveText("Working");
  await expect(card.getByTestId("elapsed")).toContainText(/\d{2}:\d{2}:\d{2}/);
  await expect(card.getByTestId("last")).toContainText("Prompt");
  await expect(card.getByTestId("capability")).toHaveText("Full");
  // The same session is a green-dotted peak on the terrain and the latest event in the dock.
  await expect(page.getByTestId("dock")).toContainText("MC-01");
});

test("CARD-02 capability none: the button copies the cwd, shows Focus manually and sends no focus call", async ({ page, mc }) => {
  await openPaired(page, mc);
  // SSH_CONNECTION makes the session remote, so the daemon gives capability none (D-17).
  await mc.send("SessionStart", { source: "startup" }, {
    session: "card02",
    agentPid: null,
    env: { SSH_CONNECTION: "present" },
  });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, {
    session: "card02",
    agentPid: null,
    env: { SSH_CONNECTION: "present" },
  });
  await openList(page);
  const card = page.getByTestId("card");
  await expect(card.getByTestId("capability")).toHaveText("None");
  const restoreRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/restore")) restoreRequests.push(r.url());
  });
  await expect(card.getByTestId("restore")).toContainText("Copy cwd");
  await card.getByTestId("restore").click();
  await expect(card.getByTestId("result")).toHaveText("Focus manually · cwd copied");
  // The Needs you card shows the same result for its 5 s.
  await expect(page.getByTestId("needs-card").getByTestId("result")).toHaveText("Focus manually · cwd copied");
  expect(await mc.countCalls("focus")).toBe(0);
  expect(restoreRequests).toHaveLength(0);
});

test("CARD-03 list rows sort permission, input, working, idle", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "resume" }, { session: "card03-idle" });
  await mc.send("SessionStart", { source: "startup" }, { session: "card03-working" });
  await mc.send("UserPromptSubmit", { prompt: "Work" }, { session: "card03-working" });
  await mc.send("SessionStart", { source: "startup" }, { session: "card03-input" });
  await mc.send("Notification", { notification_type: "idle_prompt", message: "Waiting" }, { session: "card03-input" });
  await mc.send("SessionStart", { source: "startup" }, { session: "card03-permission" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "card03-permission" });
  await expect(page.getByTestId("card")).toHaveCount(4);
  await expect(page.getByTestId("card").first()).toHaveAttribute("data-state", "needs_permission");
  const order = await page.getByTestId("card").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(order).toEqual(["needs_permission", "needs_input", "working", "idle"]);
  // The Needs you stack holds the two that need you, longest wait first.
  const stack = await page.getByTestId("needs-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(stack).toEqual(["needs_input", "needs_permission"]);
});

test("CARD-04 a daemon stop shows the daemon-down banner after 3 s and the page recovers on restart", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "card04" });
  await mc.send("UserPromptSubmit", { prompt: "Survive" }, { session: "card04" });
  await expect(page.getByTestId("card")).toHaveAttribute("data-state", "working");
  // sessions.json is saved on a 500 ms debounce; let it land before the daemon dies.
  await page.waitForTimeout(1_200);
  await mc.daemon.stop();
  const banner = page.getByTestId("banner").filter({ hasText: "Daemon not reachable" });
  await expect(banner).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId("lamp-link")).toHaveAttribute("data-color", "look");
  await mc.daemon.restart();
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("lamp-link")).toHaveAttribute("data-color", "go");
  await expect(page.getByTestId("card")).toHaveAttribute("data-state", "working");
});
