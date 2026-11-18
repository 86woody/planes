import { describe, expect, it } from "vitest";
import type { OsNotification } from "@mc/contracts";
import type { Exec } from "../src/exec.js";
import type { PlatformEnv } from "../src/types.js";
import {
  createNotifyWithConnector,
  notifyArgs,
  type NotifyArgs,
  type NotifyConnection,
  type NotifyConnector,
} from "../src/linux/notify.js";

const stubExec: Exec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
const env = { repoRoot: "/repo" } as unknown as PlatformEnv;

const base: OsNotification = {
  sessionId: "sess-1",
  title: "Permission needed",
  body: "Build <now> & waiting",
  urgency: "normal",
  tag: "perm-1",
};

/** An in-memory notification server: replaces by id like the real one. */
class FakeConnection implements NotifyConnection {
  calls: NotifyArgs[] = [];
  closed: number[] = [];
  private nextId = 1;
  private actionCbs: ((id: number, key: string) => void)[] = [];
  private closedCbs: ((id: number) => void)[] = [];
  constructor(private readonly caps: string[] = ["actions", "body", "body-markup"]) {}
  async capabilities(): Promise<string[]> {
    return this.caps;
  }
  async notify(args: NotifyArgs): Promise<number> {
    this.calls.push(args);
    const replaces = args[1];
    return replaces !== 0 ? replaces : this.nextId++;
  }
  async close(id: number): Promise<void> {
    this.closed.push(id);
  }
  onActionInvoked(cb: (id: number, key: string) => void): void {
    this.actionCbs.push(cb);
  }
  onClosed(cb: (id: number) => void): void {
    this.closedCbs.push(cb);
  }
  disconnect(): void {}
  emitAction(id: number, key: string): void {
    for (const cb of this.actionCbs) cb(id, key);
  }
  emitClosed(id: number): void {
    for (const cb of this.closedCbs) cb(id);
  }
}

function connectorTo(conn: FakeConnection | null): NotifyConnector {
  return async () => conn;
}

describe("linux notify", () => {
  it("LU-11 notifyArgs builds app name, replaces id, actions default and restore, urgency byte and expire -1", () => {
    const args = notifyArgs(base, { replacesId: 7, icon: "/repo/icon.png", sound: true, bodyMarkup: false });
    expect(args).toHaveLength(8);
    expect(args[0]).toBe("Mission Control");
    expect(args[1]).toBe(7);
    expect(args[2]).toBe("/repo/icon.png");
    expect(args[3]).toBe("Permission needed");
    expect(args[5]).toEqual(["default", "Restore", "restore", "RESTORE"]);
    expect(args[6]["urgency"]).toEqual({ signature: "y", value: 1 });
    expect(args[6]["desktop-entry"]).toEqual({ signature: "s", value: "mission-control" });
    expect(args[6]["category"]).toEqual({ signature: "s", value: "x-mission-control.attention" });
    expect(args[6]["suppress-sound"]).toEqual({ signature: "b", value: false });
    expect(args[7]).toBe(-1);
    expect(notifyArgs({ ...base, urgency: "critical" }, { replacesId: 0, icon: "", sound: false, bodyMarkup: false })[6]["urgency"]).toEqual({ signature: "y", value: 2 });
    expect(notifyArgs({ ...base, urgency: "low" }, { replacesId: 0, icon: "", sound: true, bodyMarkup: false })[6]["urgency"]).toEqual({ signature: "y", value: 0 });
  });

  it("LU-12 body is markup-escaped only when the server has body-markup", () => {
    const opts = { replacesId: 0, icon: "", sound: true };
    expect(notifyArgs(base, { ...opts, bodyMarkup: true })[4]).toBe("Build &lt;now&gt; &amp; waiting");
    expect(notifyArgs(base, { ...opts, bodyMarkup: false })[4]).toBe("Build <now> & waiting");
  });

  it("LU-13 a second notification with the same tag replaces the previous id", async () => {
    const conn = new FakeConnection();
    const notifier = createNotifyWithConnector({ exec: stubExec, env }, connectorTo(conn));
    const first = await notifier.notify(base, () => {});
    expect(first).toEqual({ id: "1" });
    const second = await notifier.notify({ ...base, body: "again" }, () => {});
    expect(conn.calls[1]?.[1]).toBe(1);
    expect(second).toEqual({ id: "1" });
    const other = await notifier.notify({ ...base, tag: "other" }, () => {});
    expect(conn.calls[2]?.[1]).toBe(0);
    expect(other).toEqual({ id: "2" });
    await notifier.dispose();
  });

  it("LU-14 no notification server: notify returns null and probe reports linux_no_notification_server", async () => {
    const notifier = createNotifyWithConnector({ exec: stubExec, env }, connectorTo(null));
    expect(await notifier.notify(base, () => {})).toBeNull();
    const probe = await notifier.probe();
    expect(probe.notify).toBe(false);
    expect(probe.issues.map((i) => i.code)).toContain("linux_no_notification_server");
    await notifier.dispose();
  });
});
