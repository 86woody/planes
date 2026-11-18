# Packaging spec: `mission-control-desktop`

Status: FROZEN at packaging plan freeze (2026-11-15). Decisions D-39..D-46. Tasks
T080..T092 (`docs/TASKS.md`, wave 8). A builder that needs this file changed writes a
`CR:` line in its checkpoint and stops.

## 1. What ships

| Artifact | Built by | Where it goes |
|---|---|---|
| `release/mission-control-desktop-<v>.tgz` | `scripts/package.mjs` (`npm pack` of `release/pkg/`) | forge release `v<v>` |
| `release/vscode-bridge-<v>.vsix` | `scripts/package.mjs` (`vsce package`) | forge release, and inside the tarball |
| `release/RELEASE-NOTES.md` | `scripts/release.mjs` (copy of root `RELEASE-NOTES.md`) | forge release body |

`release/` is git-ignored. Version `<v>` is the root `package.json` `version` (D-44),
first `1.0.0`.

## 2. Package layout (`release/pkg/`, the tarball root)

```
package.json          name mission-control-desktop, version <v>, "type": "module",
                      bin {"mc": "dist/mc.js", "mc-hook": "dist/mc-hook.js"},
                      engines {"node": ">=22"}, dependencies = the externals below,
                      each pinned to the version in package-lock.json, files = this list
README.md             install, upgrade, uninstall (section 5 text)
dist/mc.js            esbuild bundle of packages/cli/src/mc.ts
dist/daemon.js        esbuild bundle of packages/daemon/src/bin.ts
dist/mc-hook.js       esbuild bundle of packages/hook/src/mc-hook.ts (keeps its shebang)
ui/                   copy of packages/ui/dist/ (index.html, assets/)
ps/                   copy of packages/platform/src/windows/ps/*.ps1
macos-scripts/        copy of packages/platform/src/macos/scripts/*
assets/icon-256.png   copy of packages/platform/assets/icon-256.png
shell/                copy of packages/cli/assets/shell/mc.{ps1,bash,zsh}
schemas/              copy of packages/contracts/schemas/*.json
vscode-bridge.vsix    the .vsix of this version
```

esbuild options for all three entries: `bundle: true, platform: "node", format: "esm",
target: "node22"`, `define: {"__MC_PACKAGE__": JSON.stringify({version})}`, and a banner
`import { createRequire as __mcCreateRequire } from "node:module"; const require =
__mcCreateRequire(import.meta.url);` so that the externals' CJS can `require`.
`external`: `koffi`, `usocket` and `x11` (never dependencies, D-47), `fastify`, `@fastify/*`, `ws`, `ajv`, `ajv-formats`,
and every other non-workspace runtime dependency of the bundled packages (the script
derives the list from their `dependencies`, minus `@mc/*` and minus `dbus-next`, which is
bundled, D-47). Contracts' `SCHEMA_DIR`
(`new URL("../schemas", import.meta.url)`) resolves to `<pkg>/schemas` from
`<pkg>/dist/*.js`, so it needs no change.

## 3. Layout module (frozen interface, T081)

`packages/platform/src/layout.ts`, exported as the subpath `@mc/platform/layout`
(T080 adds `"./layout"` to `packages/platform/package.json` `exports`). It imports only
`node:` builtins.

```ts
export type LayoutMode = "clone" | "package";
export interface Layout {
  readonly mode: LayoutMode;
  readonly root: string;            // absolute, native separators
  readonly version: string;
  readonly mcJs: string;
  readonly daemonJs: string;
  readonly hookJs: string;
  readonly uiDir: string;
  readonly psDir: string;
  readonly macosScriptsDir: string;
  readonly iconPath: string;
  readonly shellAssetsDir: string;
  readonly schemasDir: string;
  readonly vsixPath: string | null; // null in clone mode
}
export function layoutFor(mode: LayoutMode, root: string, version: string): Layout; // pure
export function layout(): Layout; // memoised; what product code calls
```

| Field | clone (`root` = repo root) | package (`root` = package dir) |
|---|---|---|
| `mcJs` | `packages/cli/dist/mc.js` | `dist/mc.js` |
| `daemonJs` | `packages/daemon/dist/bin.js` | `dist/daemon.js` |
| `hookJs` | `packages/hook/dist/mc-hook.js` | `dist/mc-hook.js` |
| `uiDir` | `packages/ui/dist` | `ui` |
| `psDir` | `packages/platform/src/windows/ps` | `ps` |
| `macosScriptsDir` | `packages/platform/dist/macos/scripts` (T080 copies them there on build) | `macos-scripts` |
| `iconPath` | `packages/platform/assets/icon-256.png` | `assets/icon-256.png` |
| `shellAssetsDir` | `packages/cli/assets/shell` | `shell` |
| `schemasDir` | `packages/contracts/schemas` | `schemas` |
| `vsixPath` | `null` | `vscode-bridge.vsix` |

`layout()` picks the mode with `typeof __MC_PACKAGE__ !== "undefined"` (declare it as
`declare const __MC_PACKAGE__: { version: string } | undefined`).
- In package mode, `root = fileURLToPath(new URL("..", import.meta.url))`, because the
  module is inlined into `<root>/dist/<entry>.js`, and `version = __MC_PACKAGE__.version`.
- In clone mode, `root` is three levels up from the compiled module
  (`packages/platform/dist/layout.js`), and `version` is the root `package.json`
  `version`, read with `readFileSync` on first call.

Product code never computes these paths itself.

## 4. Launchers (frozen format, T083)

`packages/cli/src/installers/launcher.ts`:

```ts
export interface LauncherPaths { readonly dir: string; readonly hookJs: string; readonly mcJs: string }
export function launcherPaths(stateDir: string): LauncherPaths;      // <stateDir>/bin/...
export function launcherText(kind: "hook" | "mc", target: string, version: string): string;
export function readLauncherTarget(file: string): string | null;     // null: missing or not a launcher
export function writeLaunchers(stateDir: string, lay: Layout): { changed: boolean };
```

Launcher text, exactly (two lines; `<exit>` is `0` for `hook`, `1` for `mc`):

```
// mission-control launcher. target: <absolute target path>. version: <v>
import(<JSON.stringify(pathToFileURL(target).href)>).catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(<exit>); });
```

Both launchers and `package.json` end with exactly one newline character. A launcher whose version header
differs but whose target matches is rewritten without setting `changed`.

`writeLaunchers` creates `<stateDir>/bin/` and writes `package.json` there as
`{"type":"commonjs"}` plus both launchers. It returns `changed: false` when both
already name `lay.hookJs` and `lay.mcJs`. The file name `mc-hook.js` is kept on purpose
(D-41.2).

Installers record `launcherPaths(stateDir).hookJs` where they recorded
`<repo>/packages/hook/dist/mc-hook.js`, and `.mcJs` where they recorded
`<repo>/packages/cli/dist/mc.js`. The entry shapes (keys, events, matcher, async,
timeouts, `--chain`) are unchanged. `command`/`exec`/the node path stays
`process.execPath`.

## 5. Install, upgrade, uninstall (user flow)

```
npm i -g ./mission-control-desktop-<v>.tgz
mc init                    # asks which agents to connect (Copilot pre-selected), installs them
mc launch                  # starts the daemon if needed, then opens the page
```

- `mc init` (D-46, T092) installs each selected agent (`copilot`, `claude-code`, `codex`), then
  `uri-handler` on Windows and Linux (skipped when `MC_HOME` is set) and `vscode` when `code`,
  `code-insiders` or `cursor` is on PATH. `mc init --agents copilot,claude-code,codex` skips the
  prompt; with no TTY and no `--agents` it exits 2. Rerunning repairs. `shell` and `autostart`
  stay separate: `mc install shell|autostart`.
- `mc launch` is `mc start` then `mc open`. Both, and `mc install <target>`, remain as the
  reference commands.
- `mc start` prints `launchers updated -> <layout().root>` only when `changed`.
- **Upgrade:** `mc stop`, then `npm i -g ./mission-control-desktop-<new>.tgz`, then
  `mc launch` (or `mc start`). `mc start` rewrites the launchers if their target moved (D-41.3).
  Hooks are not rewritten.
- **Node switch:** `mc doctor` warns `hook-paths`. Run `mc init` (or `mc install <target>`) again,
  which repairs in place (D-41.4).
- **Uninstall (D-59):** `mc uninstall --all --purge`, then `npm rm -g mission-control-desktop`.
  Without `--purge` the config and state dirs stay; config.md 1 lists where. npm 7+ runs no
  uninstall scripts, so `npm rm` alone leaves every hook and file in place.

## 6. Verified where

| Check | Windows (dev-pc) | Linux (WSL) | macOS |
|---|---|---|---|
| unit IDs VR, LY, RW, LN, RP, PC, VX, IN, PK, RN, SB | gate | gate | unverified (no machine) |
| SK smoke: install the tarball into a temp prefix, run `mc` | gate stage `package` (m5) | gate stage `package` (m5) | unverified |

The SK IDs are registered with os `any`, because the registry has no "Windows and Linux"
value. A hand-run macOS `npm run gate` is expected to report them missing, and the release
notes say so.
| FM-01..FM-08 fresh-machine proof | Windows Sandbox, manual (T090) | not run | not run |

The release notes list the unverified cells (D-44.5).

## 7. Notes carried from research (2026-11-15)

- `mc-hook` already loads lean, and koffi loads dynamically on Windows only. Bundling
  removes module resolution for 15-20 files and cannot delay AC-11's 1500 ms exit
  (estimated, not measured; SK-03 measures the packaged hook).
- koffi 2.16.3's tarball ships every prebuild (26 MB) and needs no compiler.
  dbus-next is pure JS, and its optional `usocket` stays unbuilt.
- The shell installer writes `adapters.shell.enabled`, which config.md 2 now records.

## 8. Task map and file owners

| Task | Owns (create or modify only these) | Depends |
|---|---|---|
| T080 | root `package.json`, `packages/*/package.json`, `packaging-test/version-build.test.mjs`, `vitest.workspace.ts` (a `@mc/platform/layout` alias matched before `@mc/platform`; a `packaging` project over `packaging-test/**/*.test.mjs`, testTimeout 600000), `scripts/version.mjs`, `scripts/copy-platform-assets.mjs`, `scripts/test/version.test.mjs` | - |
| T081 | `packages/platform/src/layout.ts`, `packages/platform/test/layout.test.ts` | T080 |
| T082 | `packages/platform/src/windows/{notify,focus}.ts`, `packages/platform/src/linux/notify.ts`, `packages/platform/src/macos/{discover,notify}.ts`, `packages/daemon/src/main.ts`, `packages/daemon/test/layout-wiring.test.ts` | T081 |
| T083 | `packages/cli/src/installers/{launcher,manifest,uri,shell,autostart}.ts`, `packages/cli/test/{install-claude,install-other,install-launcher}.test.ts`, `packages/cli/test/fixtures/**`, and in `packages/cli/test/install-copilot.test.ts` only CP-10's path assertion | T081 |
| T084 | `packages/cli/src/installers/{claude,copilot,codex}.ts`, `packages/cli/test/install-repair.test.ts` | T083 |
| T085 | `packages/cli/src/main.ts`, `packages/cli/src/lib/{paths,system,doctor-checks}.ts`, `packages/cli/src/commands/start.ts`, `packages/cli/test/package-cli.test.ts` | T083, T084 |
| T086 | `packages/cli/src/installers/vscode.ts`, `packages/vscode-bridge/.vscodeignore`, `packages/cli/test/install-vscode-package.test.ts`, and in `packages/cli/test/install-other.test.ts` only the IX-08 `@mc/vscode-bridge` strings (after T083 merged) | T080, T081, T083 |
| T087 | `scripts/package.mjs`, `packaging-test/package.test.mjs`, `.gitignore`, `eslint.config.js` and `.prettierignore` (the `release` ignore entry only) | T082-T086 |
| T088 | `scripts/release.mjs`, `RELEASE-NOTES.md`, `packaging-test/release.test.mjs` | T087, T092 |
| T089 | `packaging-test/install.test.mjs`, `scripts/gates.json` (stage `package`, first m5: `npm run build && npm run package`, then `vitest run --project packaging`) | T087 |
| T090 | `scripts/sandbox/{make-wsb.mjs,bootstrap.ps1}`, `scripts/test/sandbox.test.mjs` | T088, T089, T092 |
| T092 | `packages/cli/src/commands/{init,launch}.ts`, `packages/cli/test/init-launch.test.ts`, and in `packages/cli/src/main.ts` only the dispatch and help lines for `init` and `launch` | T085, T086 |
| T091 | (orchestrator) `docs/USER-GUIDE.md` 2 and 9, `docs/PRD.md` 5, `docs/validation/fresh-machine-windows-<date>.md`, `HANDOFF.md` | T090 |

Bridge `.vsix` output: `packages/vscode-bridge/dist/vscode-bridge-<v>.vsix` (T080's
`package` script). esbuild is a root devDependency (T080). PK, RN and SK tests live in
`packaging-test/` and run only in the `package` stage, never in `gate-self`. Installer
context: T083 adds `layout: Layout` to `CtxInput` (optional, injectable) and `Ctx`
(required, defaulted by `makeCtx` to `layout()`); T084-T086 read `ctx.layout`. `ctx.repo`
stays and defaults to `layout.root`. `prepareLaunchers(ctx)` (manifest.ts, T083) writes the
launchers; T083 calls it from shell, uri and autostart, T084 from claude, copilot and codex,
so T083 and T084 merge back to back.

Registry safety (T084): when `MC_HOME` is set, `mc install claude-code` does not run its
automatic `installUri` step (claude.ts:121) and prints `uri-handler skipped (MC_HOME set)`.
An explicit `mc install uri-handler` still runs. With this rule no test or smoke run writes
real HKCU keys, so T089 needs no registry export or restore.

Every task also owns its `docs/checkpoints/T###.md`. `scripts/test-ids.json` and
`package-lock.json` have one writer, the orchestrator.
