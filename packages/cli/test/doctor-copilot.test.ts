import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/main.js";
import { run as doctor } from "../src/commands/doctor.js";
import { runCopilotDoctor, type CopilotDoctorDeps, type SdkClient } from "../src/lib/doctor-copilot.js";

// Fakes only: no real Copilot runtime, no prompt, no `--live`.

let root: string;
let copilotHome: string;
let mcHome: string;
let eventsPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "mc-doctor-test-"));
  copilotHome = path.join(root, "copilot");
  mcHome = path.join(root, "mc");
  mkdirSync(mcHome, { recursive: true });
  const sessionDir = path.join(copilotHome, "session-state", "sess-1");
  mkdirSync(sessionDir, { recursive: true });
  eventsPath = path.join(sessionDir, "events.jsonl");
  writeFileSync(eventsPath, '{"type":"session.start"}\n{"type":"session.shutdown"}\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function captureIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { COPILOT_HOME: copilotHome, MC_HOME: mcHome },
    cwd: root,
  };
  return { io, out, err };
}

type ClientBehaviour = { startError?: string; signedIn?: boolean; resumeAppends?: boolean };

function fakeClientClass(b: ClientBehaviour): new () => SdkClient {
  return class FakeClient {
    async start(): Promise<void> {
      if (b.startError !== undefined) throw new Error(b.startError);
    }
    async stop(): Promise<unknown> {
      return [];
    }
    async getStatus(): Promise<{ version: string; protocolVersion: number }> {
      return { version: "1.0.34", protocolVersion: 3 };
    }
    async getAuthStatus(): Promise<{ isAuthenticated: boolean }> {
      return { isAuthenticated: b.signedIn ?? true };
    }
    async listSessions(): Promise<{ sessionId: string }[]> {
      return [{ sessionId: "sess-1" }];
    }
    async listModels(): Promise<{ id: string }[]> {
      return [{ id: "model-a" }];
    }
    rpc = { account: { getQuota: async (): Promise<unknown> => ({ quotaSnapshots: {} }) } };
    async resumeSession(): Promise<{ getEvents(): Promise<unknown[]>; disconnect(): Promise<void> }> {
      if (b.resumeAppends) appendFileSync(eventsPath, '{"type":"session.resume"}\n');
      return {
        async getEvents(): Promise<unknown[]> {
          return [];
        },
        async disconnect(): Promise<void> {},
      };
    }
  };
}

function healthyDeps(client: ClientBehaviour = {}, over: Partial<CopilotDoctorDeps> = {}): CopilotDoctorDeps {
  return {
    live: false,
    nodeVersion: "22.12.0",
    platform: "win32",
    arch: "x64",
    env: { COPILOT_HOME: copilotHome, MC_HOME: mcHome },
    homeDir: root,
    loadSdk: async () => ({ CopilotClient: fakeClientClass(client) }),
    sdkManifest: async () => ({
      version: "1.0.34",
      optionalDependencies: { "@github/copilot-sdk-win32-x64": "1.0.34", "@github/copilot-sdk-linux-x64": "1.0.34" },
    }),
    hasPackage: () => true,
    loadKoffi: async () => {},
    copilotVersion: async () => "GitHub Copilot CLI 1.0.34.",
    runCopilotPrompt: async () => {
      throw new Error("the live prompt must not run in tests");
    },
    ...over,
  };
}

const lineFor = (out: string[], id: string): string => {
  const line = out.find((l) => l.includes(` ${id} `));
  if (line === undefined) throw new Error(`no line for ${id}`);
  return line;
};

describe("mc doctor copilot", () => {
  it("DC-01 all fakes healthy: every check PASS, D10 not run, 9/9, exit 0", async () => {
    const { io, out } = captureIo();
    const code = await runCopilotDoctor(io, healthyDeps());
    for (let n = 1; n <= 9; n++) expect(lineFor(out, `D${n}`).startsWith("PASS ")).toBe(true);
    expect(out.some((l) => l.includes(" D10 "))).toBe(false);
    expect(out.at(-1)).toBe("DOCTOR COPILOT PASS 9/9");
    expect(code).toBe(0);
  });

  it("DC-02 start() throws: D3 FAIL with the message, later SDK checks SKIP, exit 1", async () => {
    const { io, out } = captureIo();
    const code = await runCopilotDoctor(io, healthyDeps({ startError: "runtime refused to start" }));
    expect(lineFor(out, "D3")).toContain("FAIL D3 Runtime start  [runtime refused to start]");
    for (const id of ["D4", "D5", "D6", "D7", "D9"]) expect(lineFor(out, id).startsWith("SKIP ")).toBe(true);
    expect(out.at(-1)?.startsWith("DOCTOR COPILOT FAIL")).toBe(true);
    expect(code).toBe(1);
  });

  it("DC-03 not signed in: D5 and D7 SKIP, exit 0", async () => {
    const { io, out } = captureIo();
    const code = await runCopilotDoctor(io, healthyDeps({ signedIn: false }));
    expect(lineFor(out, "D5")).toContain("SKIP D5 Sign-in  [not signed in]");
    expect(lineFor(out, "D7").startsWith("SKIP ")).toBe(true);
    expect(code).toBe(0);
  });

  it("DC-04 D9: an attach that appends to events.jsonl FAILs; one that does not, PASSes", async () => {
    const changed = captureIo();
    const codeChanged = await runCopilotDoctor(changed.io, healthyDeps({ resumeAppends: true }));
    expect(lineFor(changed.out, "D9").startsWith("FAIL ")).toBe(true);
    expect(codeChanged).toBe(1);

    const unchanged = captureIo();
    const codeUnchanged = await runCopilotDoctor(unchanged.io, healthyDeps({}));
    expect(lineFor(unchanged.out, "D9").startsWith("PASS ")).toBe(true);
    expect(codeUnchanged).toBe(0);
  });

  it("DC-05 usage: `mc doctor copilot --bogus` exits 2 with the usage line", async () => {
    const { io, err } = captureIo();
    expect(await doctor(["copilot", "--bogus"], io)).toBe(2);
    expect(err).toEqual(["usage: mc doctor [copilot [--live]]"]);
  });
});
