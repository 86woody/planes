import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __MC_PACKAGE__: { version: string } | undefined;

export type LayoutMode = "clone" | "package";

export interface Layout {
  readonly mode: LayoutMode;
  readonly root: string;
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
  readonly vsixPath: string | null;
}

/** Pure: builds every path from `root` for the given mode. */
export function layoutFor(mode: LayoutMode, root: string, version: string): Layout {
  const r = path.resolve(root);
  const j = (...segments: string[]): string => path.join(r, ...segments);
  if (mode === "clone") {
    return {
      mode,
      root: r,
      version,
      mcJs: j("packages", "cli", "dist", "mc.js"),
      daemonJs: j("packages", "daemon", "dist", "bin.js"),
      hookJs: j("packages", "hook", "dist", "mc-hook.js"),
      uiDir: j("packages", "ui", "dist"),
      psDir: j("packages", "platform", "src", "windows", "ps"),
      macosScriptsDir: j("packages", "platform", "dist", "macos", "scripts"),
      iconPath: j("packages", "platform", "assets", "icon-256.png"),
      shellAssetsDir: j("packages", "cli", "assets", "shell"),
      schemasDir: j("packages", "contracts", "schemas"),
      vsixPath: null,
    };
  }
  return {
    mode,
    root: r,
    version,
    mcJs: j("dist", "mc.js"),
    daemonJs: j("dist", "daemon.js"),
    hookJs: j("dist", "mc-hook.js"),
    uiDir: j("ui"),
    psDir: j("ps"),
    macosScriptsDir: j("macos-scripts"),
    iconPath: j("assets", "icon-256.png"),
    shellAssetsDir: j("shell"),
    schemasDir: j("schemas"),
    vsixPath: j("vscode-bridge.vsix"),
  };
}

let memo: Layout | undefined;

/** Memoised: the layout of the running product. */
export function layout(): Layout {
  if (memo !== undefined) return memo;
  if (typeof __MC_PACKAGE__ !== "undefined") {
    const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    memo = layoutFor("package", root, __MC_PACKAGE__.version);
    return memo;
  }
  const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  memo = layoutFor("clone", root, pkg.version);
  return memo;
}
