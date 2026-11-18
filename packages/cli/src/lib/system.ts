import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { type Layout, layout } from "@mc/platform/layout";

/** Where `koffi` is resolved from: the root package.json in package mode (npm puts the dependency there), the platform package in clone mode. */
export function koffiRequireBase(lay: Layout): string {
  return lay.mode === "package" ? path.join(lay.root, "package.json") : path.join(lay.root, "packages", "platform", "package.json");
}

export function koffiRequire(lay: Layout = layout()): ReturnType<typeof createRequire> {
  return createRequire(koffiRequireBase(lay));
}

/** Fake platform (tests): never launch a browser, never touch the clipboard. */
export function isFake(env: NodeJS.ProcessEnv): boolean {
  return env["MC_PLATFORM"] === "fake";
}

/** Open the page with the OS opener. Returns false if the opener could not be started. */
export function openUrl(url: string): boolean {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/d", "/s", "/c", `start "" "${url}"`], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** Copy text to the clipboard through the OS tool, stdin-fed. Silently false when no tool exists. */
export function copyToClipboard(text: string): boolean {
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    cmd = "clip.exe";
    args = [];
  } else if (process.platform === "darwin") {
    cmd = "pbcopy";
    args = [];
  } else {
    const wl = spawnSync("sh", ["-c", "command -v wl-copy"], { encoding: "utf8" });
    if (wl.status === 0) {
      cmd = "wl-copy";
      args = [];
    } else {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    }
  }
  const res = spawnSync(cmd, args, { input: text, encoding: "utf8", windowsHide: true, timeout: 3000 });
  return res.status === 0;
}

/** AllowSetForegroundWindow(ASFW_ANY) via koffi, loaded through @mc/platform's dependency (the CLI does not declare koffi). */
export function allowSetForeground(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const req = koffiRequire();
    const koffi = req("koffi") as { load(lib: string): { func(name: string, ret: string, args: string[]): (...a: unknown[]) => unknown } };
    const user32 = koffi.load("user32.dll");
    const fn = user32.func("AllowSetForegroundWindow", "bool", ["uint32"]);
    return fn(0xffffffff) === true;
  } catch {
    return false;
  }
}
