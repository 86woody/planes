import js from "@eslint/js";
import tseslint from "typescript-eslint";

const ban = (names, extraPatterns = []) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: names.map((name) => ({
        name,
        message: "Forbidden by docs/ARCHITECTURE.md section 1 (dependency direction).",
      })),
      patterns: [
        ...names.map((name) => ({
          group: [`${name}/*`],
          message: "Forbidden by docs/ARCHITECTURE.md section 1 (dependency direction).",
        })),
        ...extraPatterns,
      ],
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "release/**",
      ".gate/**",
      "packages/contracts/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
    },
  },
  {
    files: ["packages/core/**"],
    rules: ban(["@mc/platform", "@mc/daemon"], [
      { group: ["node:*"], message: "core is pure: no Node built-ins." },
    ]),
  },
  {
    files: ["packages/ui/**", "packages/vscode-bridge/**"],
    rules: ban(["@mc/core", "@mc/platform", "@mc/daemon"]),
  },
  {
    files: ["packages/hook/**"],
    rules: ban(["@mc/daemon", "@mc/core", "fastify"]),
  },
);
