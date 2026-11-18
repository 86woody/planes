import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}-{platform}{ext}",
  workers: 1,
  retries: 0,
  // reporter is set by the gate runner (scripts/gate.mjs) on the command line
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
