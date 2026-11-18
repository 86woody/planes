import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkgs = ["contracts", "core", "platform", "daemon", "hook", "cli", "ui", "vscode-bridge"];
// Ordered array: the first match wins, so the exact layout subpath is listed before @mc/platform.
const alias: { find: RegExp; replacement: string }[] = [
  { find: /^@mc\/platform\/layout$/, replacement: root("./packages/platform/src/layout.ts") },
  ...pkgs.map((p) => ({
    find: new RegExp("^@mc/" + p + "$"),
    replacement: root(`./packages/${p}/src/index.ts`),
  })),
];
const osName = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] ?? "linux";

const project = (
  name: string,
  include: string[],
  extra: {
    exclude?: string[];
    environment?: "node" | "jsdom";
    testTimeout?: number;
    fileParallelism?: boolean;
    alias?: Record<string, string>;
    passWithNoTests?: boolean;
  } = {},
) => ({
  resolve: {
    alias: [
      ...alias,
      ...Object.entries(extra.alias ?? {}).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  test: {
    name,
    include,
    exclude: ["**/node_modules/**", "**/dist/**", ...(extra.exclude ?? [])],
    environment: extra.environment ?? "node",
    passWithNoTests: false,
    ...(extra.testTimeout !== undefined ? { testTimeout: extra.testTimeout } : {}),
    ...(extra.fileParallelism !== undefined ? { fileParallelism: extra.fileParallelism } : {}),
    ...(extra.passWithNoTests !== undefined ? { passWithNoTests: extra.passWithNoTests } : {}),
  },
});

// Vitest 5 (D-62): the projects live under test.projects in the root config; vitest.workspace.ts is gone.
export const projects = [
  project("contracts", ["packages/contracts/test/**/*.test.ts"]),
  project("platform-fake", ["packages/platform/test/fake.test.ts"]),
  project("platform", ["packages/platform/test/**/*.test.ts"], {
    exclude: ["packages/platform/test/os/**", "packages/platform/test/fake.test.ts"],
  }),
  project("platform-os", [`packages/platform/test/os/${osName}*.os.test.ts`], {
    testTimeout: 20000,
    fileParallelism: false,
  }),
  project("core", ["packages/core/test/**/*.test.ts"]),
  project("daemon", ["packages/daemon/test/**/*.test.ts"], {
    exclude: ["packages/daemon/test/integration/**", "packages/daemon/test/budget.test.ts"],
  }),
  project("daemon-integration", ["packages/daemon/test/integration/**/*.test.ts"], {
    testTimeout: 15000,
  }),
  project("budget", ["packages/daemon/test/budget.test.ts"]),
  project("hook", ["packages/hook/test/**/*.test.ts"]),
  project("cli", ["packages/cli/test/**/*.test.ts"]),
  project("ui", ["packages/ui/test/**/*.test.tsx"], { environment: "jsdom" }),
  project("vscode-bridge", ["packages/vscode-bridge/test/**/*.test.ts"], {
    alias: { vscode: root("./packages/vscode-bridge/test/vscode-mock.ts") },
  }),
  project("scripts", ["scripts/test/**/*.test.mjs"]),
  // Serial: package.test and release.test both run scripts/package.mjs, which rebuilds the
  // shared packages/vscode-bridge vsix in place (a parallel run copied a half-written vsix, PK-07).
  project("packaging", ["packaging-test/**/*.test.mjs"], {
    testTimeout: 600000,
    passWithNoTests: true,
    fileParallelism: false,
  }),
];

export default defineConfig({ test: { projects } });
