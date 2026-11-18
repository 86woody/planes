import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/exec.js";
import type { PlatformEnv } from "../../src/types.js";

// Real D-Bus: Linux only, MC_OS_TESTS=1, run under `dbus-run-session` (private session bus).
const enabled = process.platform === "linux" && process.env.MC_OS_TESTS === "1";

const stubExec: Exec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

describe.runIf(enabled)("linux notify (OS)", () => {
  it("LO-05 a test notification server receives Notify and its ActionInvoked default calls onClick with the session id", async () => {
    const dbus = await import("dbus-next");
    const { createNotify } = await import("../../src/linux/notify.js");

    const calls: { method: string; args: unknown[] }[] = [];
    let nextId = 100;

    class TestNotificationServer extends dbus.interface.Interface {
      GetCapabilities(): string[] {
        calls.push({ method: "GetCapabilities", args: [] });
        return ["actions", "body", "body-markup"];
      }
      Notify(
        appName: string,
        replacesId: number,
        appIcon: string,
        summary: string,
        body: string,
        actions: string[],
        hints: Record<string, unknown>,
        expire: number,
      ): number {
        calls.push({ method: "Notify", args: [appName, replacesId, appIcon, summary, body, actions, hints, expire] });
        return replacesId !== 0 ? replacesId : nextId++;
      }
      CloseNotification(id: number): void {
        calls.push({ method: "CloseNotification", args: [id] });
      }
      // dbus-next emits a configured signal when its method is called; the return value is the body.
      ActionInvoked(id: number, actionKey: string): [number, string] {
        return [id, actionKey];
      }
    }
    TestNotificationServer.configureMembers({
      methods: {
        GetCapabilities: { inSignature: "", outSignature: "as" },
        Notify: { inSignature: "susssasa{sv}i", outSignature: "u" },
        CloseNotification: { inSignature: "u", outSignature: "" },
      },
      signals: {
        ActionInvoked: { signature: "us" },
        NotificationClosed: { signature: "uu" },
      },
    });

    const serverBus = dbus.sessionBus();
    const server = new TestNotificationServer("org.freedesktop.Notifications");
    serverBus.export("/org/freedesktop/Notifications", server);
    const reply = await serverBus.requestName("org.freedesktop.Notifications", 0);
    expect(reply).toBe(dbus.RequestNameReply.PRIMARY_OWNER);

    const notifier = createNotify({ exec: stubExec, env: { repoRoot: process.cwd() } as unknown as PlatformEnv });
    let resolveClick!: (sessionId: string | null) => void;
    const clicked = new Promise<string | null>((resolve) => {
      resolveClick = resolve;
    });

    const handle = await notifier.notify(
      { sessionId: "sess-os-1", title: "Permission needed", body: "Build waiting", urgency: "critical", tag: "os-1" },
      (sessionId) => resolveClick(sessionId),
    );
    expect(handle).not.toBeNull();

    const notify = calls.find((c) => c.method === "Notify");
    expect(notify?.args[0]).toBe("Mission Control");
    expect(notify?.args[3]).toBe("Permission needed");
    expect(notify?.args[5]).toEqual(["default", "Restore", "restore", "RESTORE"]);
    expect(notify?.args[7]).toBe(-1);
    const hints = notify?.args[6] as Record<string, { value: unknown }>;
    expect(hints["urgency"]?.value).toBe(2);

    server.ActionInvoked(Number(handle?.id), "default");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500));
    expect(await Promise.race([clicked, timeout])).toBe("sess-os-1");

    await notifier.dispose();
    serverBus.disconnect();
  });
});
