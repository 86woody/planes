// T054 system e2e: real mc, installer, mc-hook, daemon, browser page and mc restore.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  api,
  baseUrl,
  createSandbox,
  fakeCalls,
  installedHook,
  isAlive,
  readDaemon,
  rawFixture,
  runHook,
  runMc,
  sessionEndRaw,
  type Sandbox,
} from "./system-support/harness";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const SESSION_ID = "claude-code:fixture-1";

let sb: Sandbox;
let originalSettings: Buffer;
const startedPids: number[] = [];

async function openPaired(page: Page): Promise<void> {
  const pair = await api(sb, "POST", "/api/pair-code");
  expect(pair.status).toBe(200);
  const code = (pair.json as { code: string }).code;
  await page.goto(`${baseUrl(sb)}/`);
  await expect(page.getByTestId("pair-input")).toBeVisible();
  await page.getByTestId("pair-input").fill(code);
  await page.getByTestId("pair-submit").click();
  await expect(page.getByTestId("fd-bar")).toBeVisible();
  // Every session is a row of the list view (key L, DESIGN.md 3).
  await page.getByTestId("btn-list").click();
  await expect(page.getByTestId("list")).toBeVisible();
}

test.beforeAll(async () => {
  sb = await createSandbox();
  // Pre-existing user settings with an unrelated hook, in the installer's own JSON format,
  // so that uninstall can be checked byte for byte.
  const existing = {
    model: "fixture-model",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }],
    },
  };
  const text = JSON.stringify(existing, null, 2) + "\n";
  writeFileSync(sb.settingsPath, text);
  originalSettings = Buffer.from(text);
  const install = await runMc(sb, ["install", "claude-code"]);
  expect(install.code, install.stderr).toBe(0);
});

test.afterAll(async () => {
  // Kill whatever this run started: the daemon from daemon.json and the pid `mc status` reported.
  const pids = [readDaemon(sb)?.pid, ...startedPids];
  for (const pid of pids) {
    if (pid !== undefined && isAlive(pid)) process.kill(pid);
  }
  if (sb) rmSync(sb.root, { recursive: true, force: true });
});

test("SYS-01 mc start then mc status reports the daemon", async () => {
  const start = await runMc(sb, ["start"]);
  expect(start.code, start.stderr).toBe(0);
  const status = await runMc(sb, ["status"]);
  expect(status.code, status.stderr).toBe(0);
  const header = status.stdout.split("\n")[0] ?? "";
  expect(header).toMatch(/^daemon pid=\d+ port=\d+ sessions=\d+$/);
  startedPids.push(Number(/pid=(\d+)/.exec(header)?.[1]));
  expect(header).toContain(`port=${sb.port}`);
});

test("SYS-02 installed SessionStart command creates a card visible in the page", async ({ page }) => {
  const hook = installedHook(sb, "SessionStart");
  const run = await runHook(sb, hook, rawFixture("cc-session-start.json"));
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toBe("");
  await openPaired(page);
  const card = page.getByTestId("card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("callsign")).toHaveText(/^MC-\d{2}$/);
});

test("SYS-03 installed PermissionRequest command turns the session to Needs permission and records a fake notify", async ({ page }) => {
  const hook = installedHook(sb, "PermissionRequest");
  const run = await runHook(sb, hook, rawFixture("cc-permission-request.json"));
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toBe("");
  await openPaired(page);
  const card = page.locator('[data-testid="card"][data-state="needs_permission"]');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("state-label")).toHaveText("Needs permission");
  await expect(page.getByTestId("needs-card")).toHaveCount(1);
  await expect
    .poll(async () => (await fakeCalls(sb)).some((c) => c.method === "notify"), { timeout: 10_000 })
    .toBe(true);
});

test("SYS-04 mc restore mission-control://restore/<id> --from-notification records a fake focus and acknowledges", async ({ page }) => {
  // The restore URL carries the SessionId; it is looked up from the daemon state.
  const state = await api(sb, "GET", "/api/state");
  expect(state.status).toBe(200);
  expect(JSON.stringify(state.json)).toContain(SESSION_ID);
  const uri = `mission-control://restore/${encodeURIComponent(SESSION_ID)}`;
  const run = await runMc(sb, ["restore", uri, "--from-notification"]);
  expect(run.code, run.stderr).toBe(0);
  await expect
    .poll(async () => (await fakeCalls(sb)).some((c) => c.method === "focus"), { timeout: 10_000 })
    .toBe(true);
  await openPaired(page);
  const card = page.locator('[data-testid="card"][data-state="needs_permission"]');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("ack")).toHaveCount(0);
});

test("SYS-05 installed SessionEnd command moves the session to Ended and lost", async ({ page }) => {
  const hook = installedHook(sb, "SessionEnd");
  const run = await runHook(sb, hook, sessionEndRaw());
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toBe("");
  await openPaired(page);
  // Ended rows live in the list's "Ended and lost" group, collapsed by default (DESIGN.md 3).
  await expect(page.getByTestId("splashdown")).toContainText("Ended and lost · 1");
  await expect(page.getByTestId("counts")).toContainText("No live sessions");
  await page.getByTestId("splashdown-toggle").click();
  const card = page.locator('[data-testid="card"][data-state="ended"]');
  await expect(card).toHaveCount(1);
});

test("SYS-06 mc uninstall claude-code restores the settings file byte for byte, and mc stop stops the daemon", async () => {
  const uninstall = await runMc(sb, ["uninstall", "claude-code"]);
  expect(uninstall.code, uninstall.stderr).toBe(0);
  expect(readFileSync(sb.settingsPath).equals(originalSettings)).toBe(true);

  const daemon = readDaemon(sb);
  expect(daemon).not.toBeNull();
  const stop = await runMc(sb, ["stop"]);
  expect(stop.code, stop.stderr).toBe(0);
  await expect.poll(() => isAlive(daemon!.pid), { timeout: 10_000 }).toBe(false);
  expect(readDaemon(sb)).toBeNull();
});
