import { rmSync } from "node:fs";
import path from "node:path";
import { writeAtomic } from "./json-edit.js";
import { type Ctx, fwd, isObject, mcJsPath, prepareLaunchers, readManifest, saveManifest } from "./manifest.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "MissionControl";
const PLIST_LABEL = "local.mission-control";

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** mc install autostart: windows.md 6, macos.md 5, linux.md 6. */
export async function installAutostart(ctx: Ctx): Promise<number> {
  const node = ctx.nodePath;
  const mcJs = mcJsPath(ctx);
  const manifest = readManifest(ctx);
  prepareLaunchers(ctx);

  if (ctx.platform === "win32") {
    const vbs = path.join(ctx.stateDir, "autostart.vbs");
    const text = `CreateObject("WScript.Shell").Run """${node}"" ""${mcJs}"" start", 0, False\r\n`;
    manifest.autostart = { platform: "win32", vbs, runKey: RUN_KEY, value: RUN_VALUE };
    saveManifest(ctx, manifest);
    writeAtomic(vbs, text);
    const r = await ctx.run("reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${vbs}"`, "/f"]);
    if (r.code !== 0) {
      ctx.err(`autostart: reg.exe failed: ${r.stderr.trim() || r.stdout.trim()}\n`);
      return 1;
    }
    ctx.out(`autostart: Run value ${RUN_VALUE} added\n`);
    return 0;
  }

  if (ctx.platform === "darwin") {
    const uid = ctx.uid();
    if (uid === null) {
      ctx.err("autostart: cannot read the user id for launchctl\n");
      return 1;
    }
    const plist = path.join(ctx.home, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
    const stderrPath = path.join(ctx.stateDir, "launchd.err");
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${PLIST_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      `    <string>${xml(node)}</string>`,
      `    <string>${xml(mcJs)}</string>`,
      "    <string>daemon</string>",
      "  </array>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key>",
      "  <dict><key>SuccessfulExit</key><false/></dict>",
      `  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    manifest.autostart = { platform: "darwin", plist, uid };
    saveManifest(ctx, manifest);
    writeAtomic(plist, text);
    const r = await ctx.run("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    if (r.code !== 0) {
      ctx.err(`autostart: launchctl bootstrap failed: ${r.stderr.trim() || r.stdout.trim()}\n`);
      return 1;
    }
    ctx.out(`autostart: ${plist} loaded\n`);
    return 0;
  }

  if (ctx.platform === "linux") {
    const configHome = ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config");
    if (ctx.hasSystemd()) {
      const unit = path.join(configHome, "systemd", "user", "mission-control.service");
      const text = [
        "[Unit]",
        "Description=Mission Control daemon",
        "",
        "[Service]",
        `ExecStart="${fwd(node)}" "${fwd(mcJs)}" daemon`,
        "Restart=on-failure",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n");
      manifest.autostart = { platform: "linux", mode: "systemd", unit };
      saveManifest(ctx, manifest);
      writeAtomic(unit, text);
      const r = await ctx.run("systemctl", ["--user", "enable", "--now", "mission-control.service"]);
      if (r.code !== 0) {
        ctx.err(`autostart: systemctl failed: ${r.stderr.trim() || r.stdout.trim()}\n`);
        return 1;
      }
      ctx.out(`autostart: ${unit} enabled\n`);
      return 0;
    }
    const desktop = path.join(configHome, "autostart", "mission-control.desktop");
    const text = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Mission Control",
      "NoDisplay=true",
      `Exec="${fwd(node)}" "${fwd(mcJs)}" start`,
      "",
    ].join("\n");
    manifest.autostart = { platform: "linux", mode: "xdg", desktopFile: desktop };
    saveManifest(ctx, manifest);
    writeAtomic(desktop, text);
    ctx.out(`autostart: ${desktop} written\n`);
    return 0;
  }

  ctx.err(`autostart: unsupported platform ${ctx.platform}\n`);
  return 1;
}

/** mc uninstall autostart: removes exactly the recorded artefact. */
export async function uninstallAutostart(ctx: Ctx): Promise<number> {
  const manifest = readManifest(ctx);
  const entry = manifest.autostart;
  if (!isObject(entry)) {
    ctx.out("autostart: not installed by mc\n");
    return 0;
  }
  if (entry.platform === "win32") {
    await ctx.run("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    if (typeof entry.vbs === "string") rmSync(entry.vbs, { force: true });
  } else if (entry.platform === "darwin") {
    await ctx.run("launchctl", ["bootout", `gui/${String(entry.uid)}`, String(entry.plist)]);
    if (typeof entry.plist === "string") rmSync(entry.plist, { force: true });
  } else if (entry.mode === "systemd") {
    await ctx.run("systemctl", ["--user", "disable", "--now", "mission-control.service"]);
    if (typeof entry.unit === "string") rmSync(entry.unit, { force: true });
  } else if (typeof entry.desktopFile === "string") {
    rmSync(entry.desktopFile, { force: true });
  }
  delete manifest.autostart;
  saveManifest(ctx, manifest);
  ctx.out("autostart: removed\n");
  return 0;
}
