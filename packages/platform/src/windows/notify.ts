import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Capabilities, OsNotification } from "@mc/contracts";
import type { Exec } from "../exec.js";
import { layout } from "../layout.js";
import type { NotifyHandle, PlatformEnv } from "../types.js";
import { AUMID, AUMID_KEY, PROTOCOL_KEY } from "./registry.js";
import { createToastHost, powershellPath, spawnToastHost, type ToastHost } from "./toast-host.js";

const GROUP = "mc";
const NOTIFICATION_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings";
const TOASTS_SWITCH = "NOC_GLOBAL_SETTING_TOASTS_ENABLED";

/** First 16 hex chars of SHA-256 of the notification tag (WinRT limits tags to 64 chars). */
export function toastTag(tag: string): string {
  return createHash("sha256").update(tag, "utf8").digest("hex").slice(0, 16);
}

/** Protocol activation target: restore of one session, or the page for summary notifications. */
export function toastUri(sessionId: string | null): string {
  return sessionId === null ? "mission-control://open" : `mission-control://restore/${encodeURIComponent(sessionId)}`;
}

/** The toast is silent when sound is off or the notification is low urgency. */
export function toastSilent(n: OsNotification, sound: boolean): boolean {
  return !sound || n.urgency === "low";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The toast XML of windows.md 5.2. Every text node and attribute value is XML-escaped. */
export function buildToastXml(n: OsNotification, opts: { uri: string; silent: boolean }): string {
  const uri = escapeXml(opts.uri);
  return [
    `<toast launch="${uri}" activationType="protocol">`,
    `  <visual><binding template="ToastGeneric">`,
    `    <text>${escapeXml(n.title)}</text><text>${escapeXml(n.body)}</text>`,
    `  </binding></visual>`,
    `  <actions>`,
    `    <action content="RESTORE" activationType="protocol" arguments="${uri}"/>`,
    `  </actions>`,
    `  <audio silent="${opts.silent ? "true" : "false"}"/>`,
    `</toast>`,
  ].join("\n");
}

async function regExists(run: Exec, key: string): Promise<boolean> {
  const r = await run("reg.exe", ["query", key]);
  return r.code === 0;
}

async function regDword(run: Exec, key: string, name: string): Promise<number | null> {
  const r = await run("reg.exe", ["query", key, "/v", name]);
  if (r.code !== 0) return null;
  const m = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(r.stdout);
  return m?.[1] ? parseInt(m[1], 16) : null;
}

export function createNotify(deps: { exec: Exec; env: PlatformEnv }): {
  notify(
    n: OsNotification,
    onClick: (sessionId: string | null) => void,
  ): Promise<NotifyHandle | null>;
  withdraw(h: NotifyHandle): Promise<void>;
  probe(): Promise<{ notify: boolean; notifyClick: boolean; issues: Capabilities["issues"] }>;
  dispose(): Promise<void>;
} {
  const scriptPath = path.join(layout().psDir, "toast-host.ps1");
  const host: ToastHost = createToastHost(spawnToastHost(scriptPath));

  return {
    async notify(n, _onClick) {
      // onClick is unused on Windows: a click comes back through `mc restore` (windows.md 5.3).
      const sound = deps.env.config.notifications?.sound ?? true;
      const xml = buildToastXml(n, { uri: toastUri(n.sessionId), silent: toastSilent(n, sound) });
      const tag = toastTag(n.tag);
      const reply = await host.request({ op: "show", aumid: AUMID, tag, group: GROUP, xml });
      return reply?.ok ? { id: tag } : null;
    },

    async withdraw(h) {
      await host.request({ op: "remove", aumid: AUMID, tag: h.id, group: GROUP });
    },

    async probe() {
      const aumidKey = await regExists(deps.exec, AUMID_KEY);
      const protocolKey = await regExists(deps.exec, PROTOCOL_KEY);
      const psPresent = existsSync(powershellPath());
      const issues: Capabilities["issues"] = [];

      if (!aumidKey) {
        issues.push({
          code: "windows_aumid_missing",
          severity: "warn",
          message: "Mission Control is not registered with Windows, so toasts cannot be shown.",
          fix: "mc install uri-handler",
        });
      }
      if (!protocolKey) {
        issues.push({
          code: "windows_protocol_missing",
          severity: "warn",
          message: "The mission-control:// protocol is not registered, so a toast click cannot restore a session.",
          fix: "mc install uri-handler",
        });
      }
      if ((await regDword(deps.exec, NOTIFICATION_SETTINGS, TOASTS_SWITCH)) === 0) {
        issues.push({
          code: "windows_dnd_on",
          severity: "info",
          message: "Do Not Disturb or Focus Assist is on, so toasts go to the notification centre.",
          fix: "Turn off Do Not Disturb (Settings > System > Notifications)",
        });
      }
      if ((await regDword(deps.exec, `${NOTIFICATION_SETTINGS}\\${AUMID}`, "Enabled")) === 0) {
        issues.push({
          code: "windows_app_notifications_off",
          severity: "warn",
          message: "Notifications are turned off for Mission Control.",
          fix: "Settings > System > Notifications",
        });
      }

      return { notify: aumidKey && psPresent, notifyClick: protocolKey, issues };
    },

    async dispose() {
      host.dispose();
    },
  };
}
