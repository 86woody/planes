import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/main.js";
import { parseInitArgs, run as init } from "../src/commands/init.js";
import { run as launch } from "../src/commands/launch.js";
import { hooksFile } from "../src/installers/copilot.js";
import { makeCtx } from "../src/installers/manifest.js";
import { resolveCliPaths } from "../src/lib/paths.js";
import { isAlive, readDaemonFile } from "../src/lib/daemon.js";
import { type Sandbox, sandbox } from "./fixtures/install-sandbox.js";

const T = 30_000;
const made: Sandbox[] = [];
const dirs: string[] = [];
const startedPids: number[] = [];
let daemonEnv: NodeJS.ProcessEnv | null = null;

afterEach(async () => {
  // Stop the daemon before the MC_HOME it reads its daemon.json from is deleted.
  if (daemonEnv) {
    const started = readDaemonFile(resolveCliPaths(daemonEnv));
    if (started) startedPids.push(started.pid);
    await main(["stop"], capture(daemonEnv).io);
    if (started && isAlive(started.pid)) {
      try {
        process.kill(started.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    daemonEnv = null;
  }
  for (const s of made.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandboxed(opts?: Parameters<typeof sandbox>[0]): Sandbox {
  const s = sandbox(opts);
  made.push(s);
  return s;
}

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function capture(env: NodeJS.ProcessEnv): { out: string[]; err: string[]; io: Io } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: process.cwd() } };
}

/** A writable that keeps what was written, typed as the stream init expects. */
function collector(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = { write: (s: string) => ((buf += s), true) } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

function ttyStdin(input?: string): PassThrough {
  const stdin = new PassThrough();
  stdin.end(input ?? "");
  return stdin;
}

function manifestOf(sb: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(sb.stateDir, "install-manifest.json"), "utf8")) as Record<string, unknown>;
}

function targetLines(lines: string[]): string[] {
  return lines.filter((l) => !l.startsWith("next:"));
}

describe("mc init and mc launch", () => {
  it(
    "IN-01 init with Enter at the prompt installs only Copilot, the pre-selection",
    async () => {
      const sb = sandboxed();
      const prompt = collector();
      const code = await init([], sb.io, { ...sb.input, isTTY: true, stdin: ttyStdin("\n"), stdout: prompt.stream });
      expect(code).toBe(0);
      expect(prompt.text()).toContain("1) GitHub Copilot CLI  (default)");
      expect(sb.out.some((l) => l.startsWith("copilot") && l.endsWith("installed"))).toBe(true);
      const m = manifestOf(sb);
      expect(m["copilot-cli"]).toBeDefined();
      expect(m["claude-code"]).toBeUndefined();
      expect(m.codex).toBeUndefined();
      expect(existsSync(path.join(sb.claudeDir, "settings.json"))).toBe(false);
    },
    T,
  );

  it(
    "IN-02 init accepts an explicit selection such as 2,3 and installs claude-code and codex in menu order",
    async () => {
      for (const answer of ["2,3\n", "3 2\n"]) {
        const sb = sandboxed();
        const code = await init([], sb.io, { ...sb.input, isTTY: true, stdin: ttyStdin(answer), stdout: collector().stream });
        expect(code).toBe(0);
        const lines = targetLines(sb.out);
        const claudeAt = lines.findIndex((l) => l.startsWith("claude-code"));
        const codexAt = lines.findIndex((l) => l.startsWith("codex"));
        expect(claudeAt).toBeGreaterThanOrEqual(0);
        expect(codexAt).toBeGreaterThan(claudeAt);
        expect(lines.some((l) => l.startsWith("copilot"))).toBe(false);
        const m = manifestOf(sb);
        expect(m["claude-code"]).toBeDefined();
        expect(m.codex).toBeDefined();
        expect(m["copilot-cli"]).toBeUndefined();
        sb.cleanup();
        made.splice(made.indexOf(sb), 1);
      }
    },
    T,
  );

  it(
    "IN-03 init --agents skips the prompt and installs exactly the listed agents",
    async () => {
      const sb = sandboxed();
      const neverEnded = new PassThrough();
      const code = await init(["--agents", "codex,copilot"], sb.io, {
        ...sb.input,
        isTTY: false,
        stdin: neverEnded,
        stdout: collector().stream,
      });
      expect(code).toBe(0);
      const lines = targetLines(sb.out);
      const copilotAt = lines.findIndex((l) => l.startsWith("copilot"));
      const codexAt = lines.findIndex((l) => l.startsWith("codex"));
      expect(copilotAt).toBeGreaterThanOrEqual(0);
      expect(codexAt).toBeGreaterThan(copilotAt);
      expect(lines.some((l) => l.startsWith("claude-code"))).toBe(false);
      neverEnded.destroy();
    },
    T,
  );

  it(
    "IN-04 init with no TTY and no --agents connects the default agent (Copilot) and says so (D-53)",
    async () => {
      const sb = sandboxed();
      const code = await init([], sb.io, { ...sb.input, isTTY: false, stdin: ttyStdin(), stdout: collector().stream });
      expect(code).toBe(0);
      expect(sb.errs.join("")).toBe("");
      expect(sb.out.join("\n")).toContain(
        "No terminal to ask on: connecting GitHub Copilot CLI (the default). Use --agents to choose.",
      );
      const lines = targetLines(sb.out);
      expect(lines.some((l) => l.startsWith("copilot"))).toBe(true);
      expect(lines.some((l) => l.startsWith("claude-code") || l.startsWith("codex"))).toBe(false);
      const manifest = JSON.parse(readFileSync(path.join(sb.stateDir, "install-manifest.json"), "utf8")) as Record<string, unknown>;
      expect(Object.keys(manifest)).toContain("copilot-cli");
    },
    T,
  );

  it(
    "IN-05 init prints one line per target: installed, then repaired on a rerun",
    async () => {
      const sb = sandboxed();
      const input = { ...sb.input, isTTY: false, stdin: ttyStdin(), stdout: collector().stream };
      expect(await init(["--agents", "copilot"], sb.io, input)).toBe(0);
      const first = sb.out.slice();
      const hooks = hooksFile(makeCtx(sb.io, sb.input));
      const hooksBefore = readFileSync(hooks, "utf8");
      const copilotFirst = first.find((l) => l.startsWith("copilot"));
      expect(copilotFirst?.endsWith("installed")).toBe(true);

      const before = sb.out.length;
      expect(await init(["--agents", "copilot"], sb.io, input)).toBe(0);
      const second = sb.out.slice(before);
      expect(second.find((l) => l.startsWith("copilot"))?.endsWith("repaired")).toBe(true);
      expect(readFileSync(hooks, "utf8")).toBe(hooksBefore);

      const pattern = /^(copilot|claude-code|codex|uri-handler|vscode) +(installed|repaired|skipped \(.+\)|failed \(.+\))$/;
      for (const l of targetLines(second)) expect(l).toMatch(pattern);
      expect(second[second.length - 1]).toBe("next: mc launch");
    },
    T,
  );

  it(
    "IN-06 init exits 1 when a selected agent fails and still reports the other targets",
    async () => {
      const sb = sandboxed();
      mkdirSync(path.join(sb.home, ".codex"), { recursive: true });
      writeFileSync(path.join(sb.home, ".codex", "config.toml"), 'notify = "/usr/bin/x"\n');
      const code = await init(["--agents", "copilot,codex"], sb.io, {
        ...sb.input,
        isTTY: false,
        stdin: ttyStdin(),
        stdout: collector().stream,
      });
      expect(code).toBe(1);
      expect(sb.out.some((l) => l.startsWith("codex") && l.includes("failed ("))).toBe(true);
      expect(sb.out.some((l) => l.startsWith("copilot") && l.endsWith("installed"))).toBe(true);
      expect(sb.out.some((l) => l.startsWith("next:"))).toBe(false);
    },
    T,
  );

  it(
    "IN-07 init skips uri-handler when MC_HOME is set and runs it when it is not",
    async () => {
      const input = (sb: Sandbox) => ({ ...sb.input, isTTY: false, stdin: ttyStdin(), stdout: collector().stream });

      const withHome = sandboxed({ platform: "linux" });
      expect(await init(["--agents", "copilot"], withHome.io, input(withHome))).toBe(0);
      expect(withHome.out).toContain("uri-handler  skipped (MC_HOME set)");
      expect(existsSync(path.join(withHome.home, ".local", "share", "applications", "mission-control.desktop"))).toBe(false);

      const noHome = sandboxed({ platform: "linux", noMcHome: true });
      expect(await init(["--agents", "copilot"], noHome.io, input(noHome))).toBe(0);
      const uri = noHome.out.find((l) => l.startsWith("uri-handler"));
      expect(uri?.endsWith("installed") || uri?.endsWith("repaired")).toBe(true);

      const mac = sandboxed({ platform: "darwin" });
      expect(await init(["--agents", "copilot"], mac.io, input(mac))).toBe(0);
      expect(mac.out.some((l) => l.startsWith("uri-handler"))).toBe(false);
    },
    T,
  );

  it(
    "IN-08 init runs the vscode installer only when code, code-insiders or cursor is on PATH",
    async () => {
      const sb = sandboxed();
      const none = { ...sb.input, isTTY: false, stdin: ttyStdin(), stdout: collector().stream, onPath: async () => false };
      expect(await init(["--agents", "copilot"], sb.io, none)).toBe(0);
      expect(sb.out).toContain(`${"vscode".padEnd(12)} skipped (no editor on PATH)`);

      const asked: string[] = [];
      const cursorOnly = {
        ...sb.input,
        isTTY: false,
        stdin: ttyStdin(),
        stdout: collector().stream,
        onPath: async (c: string) => {
          asked.push(c);
          return c === "cursor";
        },
      };
      const before = sb.out.length;
      expect(await init(["--agents", "copilot"], sb.io, cursorOnly)).toBe(0);
      expect(asked.slice(0, 3)).toEqual(["code", "code-insiders", "cursor"]);
      const vs = sb.out.slice(before).find((l) => l.startsWith("vscode"));
      expect(vs).toBeDefined();
      expect(vs?.includes("skipped")).toBe(false);
    },
    T,
  );

  it(
    "IN-09 init rejects an unknown agent, a bad menu answer three times, and an empty --agents list with exit 2",
    async () => {
      const sb = sandboxed();
      const base = { ...sb.input, isTTY: false, stdin: ttyStdin(), stdout: collector().stream };

      for (const argv of [["--agents", "nope"], ["--agents", ""], ["--agents"]]) {
        const before = sb.errs.length;
        expect(await init(argv, sb.io, base)).toBe(2);
        expect(sb.errs.slice(before).join("")).toContain("usage: mc init");
      }

      const menu = collector();
      const bad = await init([], sb.io, { ...sb.input, isTTY: true, stdin: ttyStdin("9\nx\n0\n"), stdout: menu.stream });
      expect(bad).toBe(2);
      expect(menu.text().split("not a choice:").length - 1).toBe(3);
      expect(existsSync(path.join(sb.stateDir, "install-manifest.json"))).toBe(false);

      const empty = await init([], sb.io, { ...sb.input, isTTY: true, stdin: ttyStdin(), stdout: collector().stream });
      expect(empty).toBe(2);
    },
    T,
  );

  it(
    "IN-10 launch starts the daemon and then opens the page",
    async () => {
      const mcHome = tempDir("mc-launch-");
      const env: NodeJS.ProcessEnv = { ...process.env, MC_HOME: mcHome, MC_PORT: "0", MC_PLATFORM: "fake", MC_TEST: "1" };
      daemonEnv = env;
      const c = capture(env);
      expect(await main(["launch"], c.io)).toBe(0);
      const started = c.out.findIndex((l) => l.startsWith("started pid="));
      const pair = c.out.findIndex((l) => l.includes("PAIR CODE"));
      expect(started).toBeGreaterThanOrEqual(0);
      expect(pair).toBeGreaterThan(started);
      expect(c.out.some((l) => l.startsWith("URL  http://127.0.0.1:"))).toBe(true);
    },
    T,
  );

  it(
    "IN-11 launch with the daemon already running only opens the page",
    async () => {
      const mcHome = tempDir("mc-launch-");
      const env: NodeJS.ProcessEnv = { ...process.env, MC_HOME: mcHome, MC_PORT: "0", MC_PLATFORM: "fake", MC_TEST: "1" };
      daemonEnv = env;
      expect(await main(["start"], capture(env).io)).toBe(0);
      const pid = readDaemonFile(resolveCliPaths(env))?.pid;
      const c2 = capture(env);
      expect(await launch([], c2.io)).toBe(0);
      expect(readDaemonFile(resolveCliPaths(env))?.pid).toBe(pid);
      expect(c2.out.some((l) => l.includes("PAIR CODE"))).toBe(true);
      expect(c2.out.some((l) => l.includes("URL"))).toBe(true);
      expect(c2.out.some((l) => l.startsWith("started pid=") || l.startsWith("already running"))).toBe(false);
    },
    T,
  );

  it(
    "IN-12 launch returns start's exit code and does not open when start fails",
    async () => {
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
      const address = holder.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      try {
        const mcHome = tempDir("mc-launch-");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          MC_HOME: mcHome,
          MC_PORT: String(port),
          MC_PLATFORM: "fake",
          MC_TEST: "1",
        };
        daemonEnv = env;
        const c = capture(env);
        expect(await launch([], c.io)).toBe(1);
        expect(c.out.some((l) => l.includes("PAIR CODE"))).toBe(false);
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    },
    T,
  );

  it(
    "IN-13 --agents accepts the list as separate words, the way PowerShell passes a,b",
    async () => {
      const sorted = (r: { agents: string[] | null } | string): string[] => {
        if (typeof r === "string" || r.agents === null) throw new Error("expected a list");
        return [...r.agents].sort();
      };
      expect(sorted(parseInitArgs(["--agents", "claude-code", "copilot"]))).toEqual(["claude-code", "copilot"]);
      expect(sorted(parseInitArgs(["--agents", "claude-code,", "copilot"]))).toEqual(["claude-code", "copilot"]);
      expect(sorted(parseInitArgs(["--agents", "copilot,claude-code"]))).toEqual(["claude-code", "copilot"]);

      const sb = sandboxed();
      const neverEnded = new PassThrough();
      const code = await init(["--agents", "claude-code", "copilot"], sb.io, {
        ...sb.input,
        isTTY: false,
        stdin: neverEnded,
        stdout: collector().stream,
      });
      expect(code).toBe(0);
      expect(sb.out.some((l) => l.startsWith("claude-code"))).toBe(true);
      expect(manifestOf(sb)["claude-code"]).toBeDefined();
      neverEnded.destroy();

      const bogus = parseInitArgs(["--agents", "claude-code", "--bogus"]);
      expect(typeof bogus === "string" && bogus.startsWith("usage: mc init")).toBe(true);
    },
    T,
  );

  it(
    "IN-14 --agents accepts one word holding a space-separated list (npm's PowerShell shim)",
    () => {
      const sorted = (r: { agents: string[] | null } | string): string[] => {
        if (typeof r === "string" || r.agents === null) throw new Error("expected a list");
        return [...r.agents].sort();
      };
      const expected = sorted(parseInitArgs(["--agents", "claude-code,copilot"]));
      expect(expected).toEqual(["claude-code", "copilot"]);
      expect(sorted(parseInitArgs(["--agents", "claude-code copilot"]))).toEqual(expected);
      expect(sorted(parseInitArgs(["--agents", " claude-code ,  copilot "]))).toEqual(expected);

      const bad = parseInitArgs(["--agents", "claude-code nope"]);
      expect(typeof bad === "string" && bad.startsWith("usage: mc init")).toBe(true);
    },
  );

  it("LK-02 no daemon started by this file is still running", async () => {
    expect(startedPids.length).toBeGreaterThanOrEqual(1);
    const deadline = Date.now() + 2_000;
    while (startedPids.some((pid) => isAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const pid of startedPids) expect(isAlive(pid)).toBe(false);
  });
});
