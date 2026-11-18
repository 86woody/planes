import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as install } from "../src/commands/install.js";
import { run as uninstall } from "../src/commands/uninstall.js";
import { SHELL_BEGIN } from "../src/installers/shell.js";
import { fwd } from "../src/installers/manifest.js";
import { launcherHook, launcherMc, NODE, REPO, type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const NODE_FWD = fwd(NODE);
const notifyOf = (s: Sandbox) => `notify = ["${NODE_FWD}", "${launcherHook(s)}", "codex"]`;

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const manifestOf = (s: Sandbox): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(path.join(s.stateDir, "install-manifest.json"), "utf8"));

describe("other installers", () => {
  it("IX-01 codex install appends notify before the first table", async () => {
    const file = path.join(sb.home, ".codex", "config.toml");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'model = "gpt-5"\n\n[profiles.a]\nname = "x"\n');
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    const text = readFileSync(file, "utf8");
    const notify = notifyOf(sb);
    expect(text).toContain(notify);
    expect(text.indexOf(notify)).toBeLessThan(text.indexOf("[profiles.a]"));
    expect(text.startsWith('model = "gpt-5"\n')).toBe(true);

    // Regression: a continuation line that starts with "[" inside a multi-line array is not a table header.
    const s2 = sandbox();
    try {
      const f2 = path.join(s2.home, ".codex", "config.toml");
      mkdirSync(path.dirname(f2), { recursive: true });
      writeFileSync(f2, 'args = [\n  ["a"],\n]\n\n[profiles.a]\nname = "x"\n');
      expect(await install(["codex"], s2.io, s2.input)).toBe(0);
      const t2 = readFileSync(f2, "utf8");
      expect(t2).toContain('args = [\n  ["a"],\n]\n\n' + notifyOf(s2) + "\n[profiles.a]");
    } finally {
      s2.cleanup();
    }
  });

  it("IX-02 codex install with an existing notify wraps it with --chain, is idempotent, and uninstall restores the file byte for byte", async () => {
    const file = path.join(sb.home, ".codex", "config.toml");
    mkdirSync(path.dirname(file), { recursive: true });
    const original = 'model = "x"\nnotify = [\n  "C:/Program Files/cu.exe", # computer use\n  \'--flag\',\n]\n[a]\nk = 1\n';
    writeFileSync(file, original);
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    const text = readFileSync(file, "utf8");
    const chain = Buffer.from(JSON.stringify(["C:/Program Files/cu.exe", "--flag"]), "utf8").toString("base64url");
    expect(text).toBe(`model = "x"
notify = ["${NODE_FWD}", "${launcherHook(sb)}", "codex", "--chain", "${chain}"]
[a]
k = 1
`);
    expect(manifestOf(sb).codex?.original).toBeDefined();
    // Idempotent: a second install does not wrap the wrapper.
    expect(await install(["codex"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(await uninstall(["codex"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);

    // A notify that is not a plain string array is still left alone, exit 1.
    const odd = 'notify = "prog"\n';
    writeFileSync(file, odd);
    expect(await install(["codex"], sb.io, sb.input)).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(odd);
    expect(sb.errs.join("")).toContain("cannot wrap");
  });

  it("IX-03 shell install appends the marked block once and enables the shell adapter", async () => {
    const profile = path.join(sb.home, ".bashrc");
    writeFileSync(profile, "export A=1\n");
    expect(await install(["shell", "--bash"], sb.io, sb.input)).toBe(0);
    expect(await install(["shell", "--bash"], sb.io, sb.input)).toBe(0);
    const text = readFileSync(profile, "utf8");
    expect(text.split(/\r?\n/).filter((l) => l === SHELL_BEGIN)).toHaveLength(1);
    const snippet = path.join(sb.stateDir, "shell", "mc.bash");
    expect(text).toContain(`. "${fwd(snippet)}"`);
    const snippetText = readFileSync(snippet, "utf8");
    expect(snippetText).not.toContain("__MC_STATE_DIR__");
    expect(snippetText).toContain(fwd(sb.stateDir));
    const envText = readFileSync(path.join(sb.stateDir, "shell.env"), "utf8");
    expect(envText).toBe(`MC_NODE=${NODE_FWD}\nMC_HOOK_JS=${launcherHook(sb)}\nMC_OTEL_DIR=${fwd(sb.stateDir)}/otel\n`);
    const cfg = JSON.parse(readFileSync(path.join(sb.configDir, "config.json"), "utf8"));
    expect(cfg.adapters.shell.enabled).toBe(true);
  });

  it("IX-04 shell uninstall removes the marked block only", async () => {
    const profile = path.join(sb.home, ".bashrc");
    writeFileSync(profile, "export A=1\n");
    await install(["shell", "--bash"], sb.io, sb.input);
    expect(await uninstall(["shell"], sb.io, sb.input)).toBe(0);
    expect(readFileSync(profile, "utf8")).toBe("export A=1\n");
    expect(existsSync(path.join(sb.stateDir, "shell.env"))).toBe(false);
    expect(manifestOf(sb).shell).toBeUndefined();

    // Regression: a damaged config.json is a warning. The block and the manifest entry are still removed,
    // and a rerun does not throw.
    const s2 = sandbox();
    try {
      const p2 = path.join(s2.home, ".bashrc");
      writeFileSync(p2, "export A=1\n");
      await install(["shell", "--bash"], s2.io, s2.input);
      writeFileSync(path.join(s2.configDir, "config.json"), "{ broken");
      expect(await uninstall(["shell"], s2.io, s2.input)).toBe(0);
      expect(readFileSync(p2, "utf8")).toBe("export A=1\n");
      expect(manifestOf(s2).shell).toBeUndefined();
      expect(s2.errs.join("")).toContain("config.json");
      expect(await uninstall(["shell"], s2.io, s2.input)).toBe(0);
    } finally {
      s2.cleanup();
    }
  });

  it("IX-05 uri-handler on windows issues the registry commands of windows.md 5.1 (wscript shim) and writes restore.vbs; --direct writes the node command", async () => {
    const win = sandbox({ platform: "win32" });
    try {
      expect(await install(["uri-handler"], win.io, win.input)).toBe(0);
      const vbs = path.join(win.stateDir, "restore.vbs");
      expect(readFileSync(vbs, "utf8")).toContain("mission-control://");
      expect(readFileSync(vbs, "utf8")).toContain(path.join(win.stateDir, "bin", "mc.js"));
      const cmd = win.calls.find((c) => c.some((a) => a.includes("shell\\open\\command")));
      expect(cmd).toBeDefined();
      expect(cmd?.join(" ")).toContain("wscript.exe");
      expect(cmd?.join(" ")).toContain("restore.vbs");
      expect(win.calls.some((c) => c[0] === "reg.exe" && c.includes("HKCU\\Software\\Classes\\AppUserModelId\\WoodyDeus.MissionControl"))).toBe(true);

      const direct = sandbox({ platform: "win32" });
      try {
        expect(await install(["uri-handler", "--direct"], direct.io, direct.input)).toBe(0);
        const dcmd = direct.calls.find((c) => c.some((a) => a.includes("shell\\open\\command")));
        expect(dcmd?.join(" ")).toContain('restore "%1" --from-notification');
        expect(dcmd?.join(" ")).toContain(`"${NODE}" "${path.join(direct.stateDir, "bin", "mc.js")}" restore "%1" --from-notification`);
        expect(existsSync(path.join(direct.stateDir, "restore.vbs"))).toBe(false);
      } finally {
        direct.cleanup();
      }
    } finally {
      win.cleanup();
    }
  });

  it("IX-06 uri-handler on linux writes the desktop file and calls xdg-mime", async () => {
    expect(await install(["uri-handler"], sb.io, sb.input)).toBe(0);
    const desktop = path.join(sb.home, ".local", "share", "applications", "mission-control.desktop");
    const text = readFileSync(desktop, "utf8");
    expect(text).toContain(`Exec="${NODE_FWD}" "${launcherMc(sb)}" restore %u --from-notification`);
    expect(text).toContain("MimeType=x-scheme-handler/mission-control;");
    expect(sb.calls).toContainEqual(["xdg-mime", "default", "mission-control.desktop", "x-scheme-handler/mission-control"]);

    // Regression: a failed xdg-mime records nothing and leaves no desktop file behind.
    const bad = sandbox({ platform: "linux", reply: (file) => (file === "xdg-mime" ? { code: 1, stderr: "no xdg" } : undefined) });
    try {
      expect(await install(["uri-handler"], bad.io, bad.input)).toBe(1);
      expect(existsSync(path.join(bad.home, ".local", "share", "applications", "mission-control.desktop"))).toBe(false);
      expect(existsSync(path.join(bad.stateDir, "install-manifest.json"))).toBe(false);
    } finally {
      bad.cleanup();
    }
  });

  it("IX-07 autostart writes the per-OS artefact and records it in the manifest", async () => {
    const win = sandbox({ platform: "win32" });
    try {
      expect(await install(["autostart"], win.io, win.input)).toBe(0);
      const vbs = path.join(win.stateDir, "autostart.vbs");
      expect(readFileSync(vbs, "utf8")).toContain('" start", 0, False');
      expect(readFileSync(vbs, "utf8")).toContain(`"${path.join(win.stateDir, "bin", "mc.js")}"`);
      expect(win.calls).toContainEqual([
        "reg.exe",
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "MissionControl",
        "/t",
        "REG_SZ",
        "/d",
        `wscript.exe "${vbs}"`,
        "/f",
      ]);
      expect(manifestOf(win).autostart?.platform).toBe("win32");
    } finally {
      win.cleanup();
    }

    const mac = sandbox({ platform: "darwin", uid: 501 });
    try {
      expect(await install(["autostart"], mac.io, mac.input)).toBe(0);
      const plist = path.join(mac.home, "Library", "LaunchAgents", "local.mission-control.plist");
      expect(readFileSync(plist, "utf8")).toContain("<string>daemon</string>");
      expect(readFileSync(plist, "utf8")).toContain(`<string>${path.join(mac.stateDir, "bin", "mc.js")}</string>`);
      expect(mac.calls).toContainEqual(["launchctl", "bootstrap", "gui/501", plist]);
      expect(manifestOf(mac).autostart?.platform).toBe("darwin");
    } finally {
      mac.cleanup();
    }

    const lin = sandbox({ platform: "linux", hasSystemd: true });
    try {
      expect(await install(["autostart"], lin.io, lin.input)).toBe(0);
      const unit = path.join(lin.home, ".config", "systemd", "user", "mission-control.service");
      const text = readFileSync(unit, "utf8");
      expect(text).toContain("Restart=on-failure");
      expect(text).toContain(`ExecStart="${NODE_FWD}" "${launcherMc(lin)}" daemon`);
      expect(lin.calls).toContainEqual(["systemctl", "--user", "enable", "--now", "mission-control.service"]);
      expect(manifestOf(lin).autostart?.mode).toBe("systemd");
    } finally {
      lin.cleanup();
    }
  });

  it("IX-08 vscode install runs build, vsce package and code --install-extension in order", async () => {
    const vs = sandbox({ platform: "win32", onPath: ["code"] });
    try {
      expect(await install(["vscode"], vs.io, vs.input)).toBe(0);
      const vsix = path.join(vs.stateDir, "mission-control-bridge.vsix");
      expect(vs.calls).toEqual([
        ["npm", "--prefix", REPO, "-w", "vscode-bridge", "run", "build"],
        ["npm", "--prefix", REPO, "-w", "vscode-bridge", "exec", "--", "vsce", "package", "--no-dependencies", "-o", vsix],
        ["code", "--install-extension", vsix],
      ]);
      expect(manifestOf(vs).vscode?.installedWith).toEqual(["code"]);
      expect(manifestOf(vs).vscode?.extensionId).toBe("woody.vscode-bridge");
    } finally {
      vs.cleanup();
    }

    // Regression: code succeeds and cursor fails. code is recorded at once, so uninstall still reaches it.
    const pf = sandbox({
      platform: "win32",
      onPath: ["code", "cursor"],
      reply: (file) => (file === "cursor" ? { code: 1, stderr: "boom" } : undefined),
    });
    try {
      expect(await install(["vscode"], pf.io, pf.input)).toBe(1);
      expect(manifestOf(pf).vscode?.installedWith).toEqual(["code"]);
      expect(await uninstall(["vscode"], pf.io, pf.input)).toBe(0);
      expect(pf.calls).toContainEqual(["code", "--uninstall-extension", "woody.vscode-bridge"]);
    } finally {
      pf.cleanup();
    }
  });
});
