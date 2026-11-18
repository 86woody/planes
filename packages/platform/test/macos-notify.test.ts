import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OsNotification } from "@mc/contracts";
import type { Exec } from "../src/exec.js";
import type { PlatformEnv } from "../src/types.js";
import {
  alerterArgs,
  createNotify,
  terminalNotifierArgs,
} from "../src/macos/notify.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

const n: OsNotification = {
  sessionId: "sess-1",
  title: "Claude is waiting",
  body: "Needs your input",
  urgency: "normal",
  tag: "mc-sess-1",
};

const env = {
  stateDir: "/tmp/mc-test",
  repoRoot: "/tmp/mc-repo",
  displayEnv: () => ({}),
} as unknown as PlatformEnv;

/** Make `which` (spawnSync) find only the listed commands. */
function installWhich(found: string[]): void {
  vi.mocked(spawnSync).mockImplementation(((_file: string, args: string[]) => {
    const cmd = args[args.length - 1] ?? "";
    const hit = found.includes(cmd);
    return { status: hit ? 0 : 1, stdout: hit ? `/opt/homebrew/bin/${cmd}\n` : "" };
  }) as unknown as typeof spawnSync);
}

function fakeChild(): EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.kill = vi.fn();
  return child;
}

const noExec: Exec = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync).mockReset();
});

describe("macos notify", () => {
  it("MU-09 alerterArgs has -title -message -group -actions RESTORE -timeout 600 -json", () => {
    const args = alerterArgs(n);
    expect(args).toEqual([
      "-title", "Claude is waiting",
      "-message", "Needs your input",
      "-group", "mc-sess-1",
      "-actions", "RESTORE",
      "-timeout", "600",
      "-json",
    ]);
  });

  it("MU-10 terminalNotifierArgs -execute quotes paths with spaces and single quotes", () => {
    const args = terminalNotifierArgs(n, {
      node: "/opt/node dir/it's/node",
      mcJs: "/Users/a b/repo/packages/cli/dist/mc.js",
    });
    const i = args.indexOf("-execute");
    expect(i).toBeGreaterThan(-1);
    const cmd = args[i + 1] ?? "";
    expect(cmd).toContain("'/opt/node dir/it'\\''s/node'");
    expect(cmd).toContain("'/Users/a b/repo/packages/cli/dist/mc.js'");
    expect(cmd).toContain("restore");
    expect(cmd).toContain("--from-notification");
    expect(args).toContain("-group");
    expect(args[args.indexOf("-group") + 1]).toBe("mc-sess-1");
  });

  it("MU-11 alerter JSON contentsClicked calls onClick with the session id; timeout does not", async () => {
    installWhich(["alerter"]);
    const first = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as unknown as ReturnType<typeof spawn>);
    const notifier = createNotify({ exec: noExec, env });
    expect(notifier.backend).toBe("alerter");

    const onClick = vi.fn();
    const handle = await notifier.notify(n, onClick);
    expect(handle).not.toBeNull();
    first.stdout.emit("data", '{"activationType":"contentsClicked"}');
    first.emit("close", 0);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith("sess-1");

    const second = fakeChild();
    vi.mocked(spawn).mockReturnValueOnce(second as unknown as ReturnType<typeof spawn>);
    const onTimeout = vi.fn();
    await notifier.notify(n, onTimeout);
    second.stdout.emit("data", '{"activationType":"timeout"}');
    second.emit("close", 0);
    expect(onTimeout).not.toHaveBeenCalled();
    await notifier.dispose();
  });

  it("MU-12 probe reports notifyClick false and the info issue for the osascript backend", async () => {
    installWhich([]);
    const notifier = createNotify({ exec: noExec, env });
    expect(notifier.backend).toBe("osascript");
    const p = await notifier.probe();
    expect(p.notify).toBe(true);
    expect(p.notifyClick).toBe(false);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({
      code: "macos_notify_no_click",
      severity: "info",
      fix: "brew install vjeantet/tap/alerter",
    });
  });
});
