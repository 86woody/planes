import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { OsNotification } from "@mc/contracts";
import { buildToastXml, toastSilent, toastTag, toastUri } from "../src/windows/notify.js";
import { protocolCommand, regCommands, restoreVbs } from "../src/windows/registry.js";
import { createToastHost, type HostChild } from "../src/windows/toast-host.js";

const base: OsNotification = {
  sessionId: "sess 1&x/y",
  title: `<Permission> & "needed" 's`,
  body: "Build · waiting <now>",
  urgency: "normal",
  tag: "perm-1",
};

describe("windows notify", () => {
  it("WU-13 buildToastXml escapes title and body and sets protocol activation with the encoded id", () => {
    const xml = buildToastXml(base, { uri: toastUri(base.sessionId), silent: false });
    expect(xml).toContain("&lt;Permission&gt; &amp; &quot;needed&quot; &apos;s");
    expect(xml).toContain("Build · waiting &lt;now&gt;");
    expect(xml).not.toContain("<Permission>");
    expect(xml).toContain(`launch="mission-control://restore/sess%201%26x%2Fy" activationType="protocol"`);
    expect(xml).toContain(`arguments="mission-control://restore/sess%201%26x%2Fy"`);
    expect(xml).toContain(`<audio silent="false"/>`);
    expect(toastSilent({ ...base, urgency: "low" }, true)).toBe(true);
    expect(toastSilent(base, false)).toBe(true);
    expect(buildToastXml(base, { uri: toastUri(base.sessionId), silent: true })).toContain(`<audio silent="true"/>`);
  });

  it("WU-14 summary notification uses mission-control://open", () => {
    const summary: OsNotification = { ...base, sessionId: null, tag: "summary" };
    const xml = buildToastXml(summary, { uri: toastUri(null), silent: false });
    expect(toastUri(null)).toBe("mission-control://open");
    expect(xml).toContain(`launch="mission-control://open"`);
    expect(xml).toContain(`arguments="mission-control://open"`);
  });

  it("WU-15 toastTag is 16 hex chars and stable", () => {
    const tag = toastTag("perm-1");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(toastTag("perm-1")).toBe(tag);
    expect(tag).toBe(createHash("sha256").update("perm-1", "utf8").digest("hex").slice(0, 16));
    expect(toastTag("perm-2")).not.toBe(tag);
  });

  it("WU-16 regCommands produce the exact keys and values of windows.md 5.1", () => {
    const cmd = protocolCommand({
      mode: "shim",
      stateDir: "C:\\State",
      nodePath: "C:\\node\\node.exe",
      mcJsPath: "C:\\repo\\packages\\cli\\dist\\mc.js",
    });
    expect(cmd).toBe(`wscript.exe "C:\\State\\restore.vbs" "%1"`);
    expect(
      regCommands({ iconPath: "C:\\repo\\packages\\platform\\assets\\icon-256.png", protocolCommand: cmd }),
    ).toEqual([
      ["add", "HKCU\\Software\\Classes\\AppUserModelId\\WoodyDeus.MissionControl", "/v", "DisplayName", "/t", "REG_SZ", "/d", "Mission Control", "/f"],
      ["add", "HKCU\\Software\\Classes\\AppUserModelId\\WoodyDeus.MissionControl", "/v", "IconUri", "/t", "REG_SZ", "/d", "C:\\repo\\packages\\platform\\assets\\icon-256.png", "/f"],
      ["add", "HKCU\\Software\\Classes\\mission-control", "/ve", "/t", "REG_SZ", "/d", "URL:Mission Control", "/f"],
      ["add", "HKCU\\Software\\Classes\\mission-control", "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"],
      ["add", "HKCU\\Software\\Classes\\mission-control\\shell\\open\\command", "/ve", "/t", "REG_SZ", "/d", cmd, "/f"],
    ]);
    expect(
      protocolCommand({ mode: "direct", stateDir: "C:\\State", nodePath: "C:\\node\\node.exe", mcJsPath: "C:\\m\\mc.js" }),
    ).toBe(`"C:\\node\\node.exe" "C:\\m\\mc.js" restore "%1" --from-notification`);
  });

  it("WU-17 restoreVbs embeds node and mc.js paths and its guard rejects arguments with a quote or another scheme", () => {
    const vbs = restoreVbs("C:\\node\\node.exe", "C:\\repo\\packages\\cli\\dist\\mc.js");
    expect(vbs).toContain(
      `CreateObject("WScript.Shell").Run """C:\\node\\node.exe"" ""C:\\repo\\packages\\cli\\dist\\mc.js"" restore """ & u & """ --from-notification", 0, False`,
    );
    expect(vbs).toContain(`If WScript.Arguments.Count <> 1 Then WScript.Quit 2`);
    expect(vbs).toContain(`If InStr(u, """") > 0 Or Left(LCase(u), 18) <> "mission-control://" Then WScript.Quit 2`);
    expect("mission-control://".length).toBe(18);
    expect(() => restoreVbs('C:\\bad"node.exe', "C:\\m.js")).toThrow();
  });
});

class FakeChild implements HostChild {
  readonly written: string[] = [];
  killed = 0;
  private dataListeners: Array<(chunk: string) => void> = [];
  private exitListeners: Array<() => void> = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
  };
  readonly stdout = {
    setEncoding: (_encoding: "utf8"): void => {},
    on: (_event: "data", listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener);
    },
  };
  on(_event: "exit", listener: () => void): void {
    this.exitListeners.push(listener);
  }
  kill(): boolean {
    this.killed++;
    return true;
  }
  reply(obj: unknown): void {
    for (const l of this.dataListeners) l(`${JSON.stringify(obj)}\n`);
  }
  requestId(index: number): number {
    const line = this.written[index];
    if (line === undefined) throw new Error(`no request ${index}`);
    return (JSON.parse(line) as { id: number }).id;
  }
}

describe("toast host", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("WU-18 toast host: replies are matched by id, first request gets 6000 ms, a later timeout kills and restarts the host, and the request line for a title with · is valid UTF-8", async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const host = createToastHost(() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    });

    // First request of a process: 6000 ms.
    let first: unknown = "pending";
    const p1 = host.request({ op: "history", aumid: "A" }).then((r) => (first = r));
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5999);
    expect(first).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await p1).toBeNull();
    expect(children[0]?.killed).toBe(1);

    // The next request starts a new process; its first request also gets 6000 ms.
    const p2 = host.request({ op: "history", aumid: "A" });
    expect(children).toHaveLength(2);
    const c2 = children[1]!;
    const p3 = host.request({ op: "history", aumid: "A" });
    const id2 = c2.requestId(0);
    const id3 = c2.requestId(1);
    expect(id3).toBe(id2 + 1);
    // Replies arrive out of order and are matched by id.
    c2.reply({ id: id3, ok: true, tags: ["b"] });
    c2.reply({ id: id2, ok: true, tags: ["a"] });
    expect(await p3).toEqual({ id: id3, ok: true, tags: ["b"] });
    expect(await p2).toEqual({ id: id2, ok: true, tags: ["a"] });

    // Later requests get 2000 ms; a timeout kills the host and returns null.
    let later: unknown = "pending";
    const p4 = host.request({ op: "history", aumid: "A" }).then((r) => (later = r));
    await vi.advanceTimersByTimeAsync(1999);
    expect(later).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await p4).toBeNull();
    expect(c2.killed).toBe(1);
    expect(children).toHaveLength(2);

    // After the kill, the next request restarts the host.
    const p5 = host.request({ op: "history", aumid: "A" });
    expect(children).toHaveLength(3);
    host.dispose();
    expect(await p5).toBeNull();

    // A request line carrying a title with · is valid UTF-8 and round-trips.
    vi.useRealTimers();
    const host2 = createToastHost(() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    });
    const title = "Build · done";
    void host2.request({ op: "show", aumid: "A", tag: "t", group: "mc", xml: `<text>${title}</text>` });
    const c4 = children[children.length - 1]!;
    const line = c4.written[0]!;
    expect(line.endsWith("\n")).toBe(true);
    expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
    expect((JSON.parse(line) as { xml: string }).xml).toBe(`<text>${title}</text>`);
    host2.dispose();
  });
});
