import { rmSync } from "node:fs";
import path from "node:path";
import {
  AUMID,
  AUMID_KEY,
  PROTOCOL,
  PROTOCOL_KEY,
  registerAumid,
  registerProtocol,
  unregisterAll,
} from "@mc/platform";
import { writeAtomic } from "./json-edit.js";
import { type Ctx, fwd, isObject, mcJsPath, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

const DESKTOP_NAME = "mission-control.desktop";

/** mc install uri-handler [--direct]: windows.md 5.1 (Windows), linux.md 6 (Linux), nothing on macOS. */
export async function installUri(ctx: Ctx, direct: boolean): Promise<number> {
  if (ctx.platform === "darwin") {
    ctx.out("uri-handler: not needed on macOS\n");
    return 0;
  }
  if (ctx.platform === "win32") return installWindows(ctx, direct);
  if (ctx.platform === "linux") return installLinux(ctx);
  ctx.err(`uri-handler: unsupported platform ${ctx.platform}\n`);
  return 1;
}

async function installWindows(ctx: Ctx, direct: boolean): Promise<number> {
  const iconPath = ctx.layout.iconPath;
  const mcJs = mcJsPath(ctx);
  const mode = direct ? "direct" : "shim";
  const restoreVbs = direct ? null : path.join(ctx.stateDir, "restore.vbs");
  try {
    prepareLaunchers(ctx);
    await registerAumid(iconPath, ctx.run);
    const r = await registerProtocol({ mode, stateDir: ctx.stateDir, nodePath: ctx.nodePath, mcJsPath: mcJs }, ctx.run);
    if (r.restoreVbs !== undefined && restoreVbs !== null) writeAtomic(restoreVbs, r.restoreVbs);
  } catch (err) {
    // Nothing is recorded on failure, so a retry runs the whole installer again.
    ctx.err(`uri-handler: ${(err as Error).message}\n`);
    return 1;
  }
  // Recorded only once every platform call has succeeded.
  const manifest = readManifest(ctx);
  manifest["uri-handler"] = {
    platform: "win32",
    mode,
    aumid: AUMID,
    aumidKey: AUMID_KEY,
    protocol: PROTOCOL,
    protocolKey: PROTOCOL_KEY,
    restoreVbs,
  };
  saveManifest(ctx, manifest);
  ctx.out(`uri-handler: registered ${PROTOCOL}:// (${mode} mode)\n`);
  return 0;
}

async function installLinux(ctx: Ctx): Promise<number> {
  prepareLaunchers(ctx);
  const dir = path.join(ctx.home, ".local", "share", "applications");
  const desktop = path.join(dir, DESKTOP_NAME);
  const mcJs = fwd(mcJsPath(ctx));
  const text = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Mission Control",
    "NoDisplay=true",
    `Exec="${fwd(ctx.nodePath)}" "${mcJs}" restore %u --from-notification`,
    "MimeType=x-scheme-handler/mission-control;",
    "",
  ].join("\n");
  writeAtomic(desktop, text);
  const x = await ctx.run("xdg-mime", ["default", DESKTOP_NAME, "x-scheme-handler/mission-control"], { timeoutMs: 30000 });
  if (x.code !== 0) {
    // Nothing is recorded on failure: remove the half-done desktop file so a retry starts clean.
    rmSync(desktop, { force: true });
    ctx.err(`uri-handler: xdg-mime failed: ${x.stderr.trim() || x.stdout.trim() || `code ${x.code}`}\n`);
    return 1;
  }
  // Recorded only once xdg-mime has succeeded.
  const manifest = readManifest(ctx);
  manifest["uri-handler"] = { platform: "linux", desktopFile: desktop, mime: "x-scheme-handler/mission-control" };
  saveManifest(ctx, manifest);
  await ctx.run("update-desktop-database", [dir], { timeoutMs: 30000 });
  ctx.out(`uri-handler: wrote ${desktop}\n`);
  return 0;
}

/** mc uninstall uri-handler: removes exactly what the manifest says was written. */
export async function uninstallUri(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest["uri-handler"];
  if (!isObject(entry)) {
    ctx.out("uri-handler: not installed by mc\n");
    return 0;
  }
  if (entry.platform === "win32") {
    await unregisterAll(ctx.run);
    if (typeof entry.restoreVbs === "string") rmSync(entry.restoreVbs, { force: true });
  } else if (entry.platform === "linux" && typeof entry.desktopFile === "string") {
    rmSync(entry.desktopFile, { force: true });
    await ctx.run("update-desktop-database", [path.dirname(entry.desktopFile)], { timeoutMs: 30000 });
  }
  delete manifest["uri-handler"];
  saveManifest(ctx, manifest);
  ctx.out("uri-handler: removed\n");
  return 0;
}
