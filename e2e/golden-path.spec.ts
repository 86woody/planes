import { expect } from "@playwright/test";
import { test } from "./support/daemon";
import { cardFor, openList, openPaired } from "./support/page";

test("GP-01 SessionStart makes a Starting row appear in the list within 1 s", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  const t0 = Date.now();
  await mc.send("SessionStart", { source: "startup" }, { session: "gp01" });
  const card = page.getByTestId("card");
  await expect(card).toHaveCount(1, { timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);
  await expect(card).toHaveAttribute("data-state", "starting");
  await expect(card.getByTestId("state-label")).toHaveText("Starting");
});

test("GP-02 UserPromptSubmit turns it Working", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp02" });
  await mc.send("UserPromptSubmit", { prompt: "Add a test" }, { session: "gp02" });
  const card = page.getByTestId("card");
  await expect(card).toHaveAttribute("data-state", "working");
  await expect(card.getByTestId("state-label")).toHaveText("Working");
});

test("GP-03 PermissionRequest reads Needs permission, adds a Needs you card and a peak pill, and the fake platform records one notify", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp03" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "gp03" });
  const needs = page.getByTestId("needs-card");
  await expect(needs).toHaveCount(1);
  await expect(needs).toHaveAttribute("data-state", "needs_permission");
  await expect(needs.getByTestId("state-label")).toHaveText("Needs permission");
  await expect(page.getByTestId("callout")).toBeVisible();
  await expect(page.getByTestId("callout")).toContainText("MC-01");
  await expect(page.getByTestId("counts")).toContainText("1 session needs you");
  await openList(page);
  await expect(page.getByTestId("card").getByTestId("state-label")).toHaveText("Needs permission");
  await expect.poll(() => mc.countCalls("notify")).toBe(1);
});

test("GP-04 Restore calls fake focus once, shows Focused, and attention becomes acknowledged", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp04" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "gp04" });
  const card = page.getByTestId("card");
  await expect(card).toHaveAttribute("data-state", "needs_permission");
  await card.getByTestId("restore").click();
  await expect.poll(() => mc.countCalls("focus")).toBe(1);
  await expect(card.getByTestId("result")).toHaveText("Focused");
  await expect(card.getByTestId("ack")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-attention", "acked");
  await expect(page.getByTestId("needs-card")).toHaveAttribute("data-attention", "acked");
});

test("GP-05 PostToolUse returns it to Working and the Needs you stack reads all clear", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp05" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "gp05" });
  await expect(page.getByTestId("needs-card")).toHaveCount(1);
  await mc.send("PostToolUse", { tool_name: "Bash" }, { session: "gp05" });
  await expect(page.getByTestId("needs-card")).toHaveCount(0);
  await expect(page.getByTestId("all-clear")).toBeVisible();
  await expect(page.getByTestId("callout")).toHaveCount(0);
  await openList(page);
  const card = page.getByTestId("card");
  await expect(card).toHaveAttribute("data-state", "working");
  await expect(card.getByTestId("state-label")).toHaveText("Working");
});

test("GP-06 Stop reads Done and asks for review; Acknowledge quiets it", async ({ page, mc }) => {
  await openPaired(page, mc);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp06" });
  await mc.send("UserPromptSubmit", { prompt: "Fix it" }, { session: "gp06" });
  await mc.send("Stop", { last_assistant_message: "Fixed." }, { session: "gp06" });
  const needs = page.getByTestId("needs-card");
  await expect(needs.getByTestId("state-label")).toHaveText("Done · review");
  await expect(needs).toHaveAttribute("data-attention", "active");
  await openList(page);
  const card = page.getByTestId("card");
  await expect(card.getByTestId("state-label")).toHaveText("Done");
  await card.getByTestId("ack").click();
  await expect(card).toHaveAttribute("data-attention", "acked");
  await expect(needs).toHaveAttribute("data-attention", "acked");
  await expect(needs.getByTestId("state-label")).not.toHaveClass(/look/);
});

test("GP-07 with the session set as foreground, a new PermissionRequest records no notify", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp07" });
  await mc.setForeground(mc.sid("gp07"));
  await mc.send("UserPromptSubmit", { prompt: "Run it" }, { session: "gp07" });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "gp07" });
  await expect(cardFor(page, "MC-01")).toHaveAttribute("data-state", "needs_permission");
  // A second session with no agent has no window, so it is not foreground: its notify is the
  // sentinel that the daemon has finished processing the foreground session's event.
  await mc.send("SessionStart", { source: "startup" }, { session: "gp07b", agentPid: null });
  await mc.send("PermissionRequest", { tool_name: "Bash" }, { session: "gp07b", agentPid: null });
  await expect(cardFor(page, "MC-02")).toHaveAttribute("data-state", "needs_permission");
  await expect.poll(() => mc.countCalls("notify")).toBe(1);
  expect(await mc.countCalls("notify")).toBe(1);
});

test("GP-08 SessionEnd moves the row to Ended and lost and Dismiss removes it", async ({ page, mc }) => {
  await openPaired(page, mc);
  await openList(page);
  await mc.send("SessionStart", { source: "startup" }, { session: "gp08" });
  await mc.send("SessionEnd", { reason: "logout" }, { session: "gp08" });
  const splash = page.getByTestId("splashdown");
  await expect(splash).toBeVisible();
  await expect(splash).toContainText("Ended and lost · 1");
  await page.getByTestId("splashdown-toggle").click();
  const card = splash.getByTestId("card");
  await expect(card).toHaveAttribute("data-state", "ended");
  await expect(card.getByTestId("state-label")).toHaveText("Ended");
  await card.getByTestId("dismiss").click();
  await expect(page.getByTestId("card")).toHaveCount(0);
});
