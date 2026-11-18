import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const snippets = path.resolve(here, "../assets/shell");
const BASH = path.join(snippets, "mc.bash");
const ZSH = path.join(snippets, "mc.zsh");
const PS1 = path.join(snippets, "mc.ps1");

interface Event {
  event: string;
  args: string[];
  t: number;
}

/** Returns the absolute path of a command, or null when it is not on PATH. */
function whichOf(cmd: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "");
  return out ?? null;
}

/**
 * Git for Windows bash. On win32, System32\bash.exe and WindowsApps\bash.exe are the WSL
 * launcher, so PATH order is never trusted there.
 */
function gitBash(): string | null {
  if (process.platform !== "win32") return whichOf("bash");
  const candidates: string[] = [];
  const found = spawnSync("where", ["git"], { encoding: "utf8" });
  for (const line of (found.stdout ?? "").split(/\r?\n/)) {
    const g = line.trim().toLowerCase();
    if (g.endsWith("\\cmd\\git.exe") || g.endsWith("\\bin\\git.exe")) {
      candidates.push(path.join(path.dirname(path.dirname(line.trim())), "bin", "bash.exe"));
    }
  }
  candidates.push("C:\\Program Files\\Git\\bin\\bash.exe");
  for (const c of candidates) {
    if (/system32|windowsapps/i.test(c)) continue;
    if (existsSync(c)) return c;
  }
  return null;
}

const BASH_EXE = gitBash();

/** Shells read paths with forward slashes; Windows node paths work with them too. */
function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Path form Git Bash understands for a Windows path: C:\x\y becomes /c/x/y. */
function bashPath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (!m) return posix(p);
  return `/${(m[1] ?? "c").toLowerCase()}/${posix(m[2] ?? "")}`;
}

/** Environment for Git Bash: its usr/bin supplies sh and sleep. */
function bashEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (process.platform === "win32" && BASH_EXE !== null) {
    const root = path.dirname(path.dirname(BASH_EXE));
    const base = process.env.PATH ?? process.env.Path ?? "";
    delete e.Path;
    e.PATH = [path.join(root, "usr", "bin"), path.join(root, "bin"), base].join(";");
  }
  return e;
}

let dir = "";
let logFile = "";
let hookFile = "";
let envFile = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mc-shell-"));
  logFile = path.join(dir, "events.jsonl");
  hookFile = path.join(dir, "fake-hook.mjs");
  envFile = path.join(dir, "state", "shell.env");
  mkdirSync(path.join(dir, "state"));
  // Fake mc-hook: appends its argv and a process-start timestamp as one JSON line.
  // The timestamp is the hook process start (ingest.md 3), so it orders events that
  // were launched back to back.
  writeFileSync(
    hookFile,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({`,
      "  event: process.argv[3] ?? '',",
      "  args: process.argv.slice(4),",
      "  t: performance.timeOrigin + performance.now(),",
      '}) + "\\n");',
      "",
    ].join("\n"),
  );
  writeFileSync(envFile, `MC_NODE=${posix(process.execPath)}\nMC_HOOK_JS=${posix(hookFile)}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readEvents(): Event[] {
  let raw: string;
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Event)
    .sort((a, b) => a.t - b.t);
}

async function waitForEvents(n: number, timeoutMs = 4000): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEvents();
    if (events.length >= n) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readEvents();
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, MC_SHELL_ENV: posix(envFile), ...extra };
}

function runBash(script: string, extra: Record<string, string> = {}, snippet = BASH) {
  if (BASH_EXE === null) throw new Error("no Git Bash found");
  return spawnSync(BASH_EXE, ["-c", script], {
    encoding: "utf8",
    env: bashEnv({ MC_SHELL_ENV: bashPath(envFile), MC_SNIP: bashPath(snippet), ...extra }),
  });
}

// Drives one prompt cycle per call: the prompt hook, then the command, then the prompt again.
// The pause after sourcing is human-scale: on Linux, node starts in about a millisecond, so
// hooks launched back to back can swap their start timestamps.
const BASH_SESSION = [
  'source "$MC_SNIP"',
  "sleep 0.2",
  'eval "$PROMPT_COMMAND"',
  "sh -c 'sleep 0.3; exit 3'",
  'eval "$PROMPT_COMMAND"',
  "sleep 0.5",
].join("\n");

describe("shell integration snippets", () => {
  it("SH-01 bash: sourcing sends ShellStart", async () => {
    if (BASH_EXE === null) {
      expect(BASH_EXE).toBeNull();
      return;
    }
    const r = runBash('source "$MC_SNIP"; sleep 0.2');
    expect(r.status).toBe(0);
    const events = await waitForEvents(1);
    // The EXIT trap adds ShellExit when the shell ends; only the first event matters here.
    expect(events[0]?.event).toBe("ShellStart");
    expect(events[0]?.args).toEqual([]);
    expect(events.filter((e) => e.event === "ShellStart")).toHaveLength(1);
  });

  it("SH-02 bash: a command sends ShellCommandStart with the first word only, then ShellCommandEnd with exit code and ShellPrompt", async () => {
    if (BASH_EXE === null) {
      expect(BASH_EXE).toBeNull();
      return;
    }
    const r = runBash(BASH_SESSION);
    expect(r.status).toBe(0);
    const events = await waitForEvents(5);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("ShellStart");
    expect(names.filter((n) => n === "ShellPrompt").length).toBe(2);

    const start = events.find((e) => e.event === "ShellCommandStart");
    expect(start?.args).toEqual(["--command", "sh"]);

    const end = events.find((e) => e.event === "ShellCommandEnd");
    expect(end).toBeDefined();
    expect(end?.args.slice(0, 2)).toEqual(["--exit", "3"]);
    expect(end?.args[2]).toBe("--duration-ms");
    expect(Number(end?.args[3])).toBeGreaterThanOrEqual(200);
    expect(end?.args.slice(4)).toEqual(["--command", "sh"]);

    // Start is launched 300 ms before End, so their order is stable.
    expect(names.indexOf("ShellCommandStart")).toBeLessThan(names.indexOf("ShellCommandEnd"));
    // The command's arguments are never sent.
    expect(JSON.stringify(events)).not.toContain("exit 3");
  });

  it("SH-03 zsh: same sequence via preexec and precmd", async () => {
    const zsh = whichOf("zsh");
    if (zsh === null) {
      expect(whichOf("zsh")).toBeNull();
      return;
    }
    const script = [
      "source \"$MC_SNIP\"",
      "__mc_preexec \"sh -c 'sleep 0.3; exit 3'\"",
      "sh -c 'sleep 0.3; exit 3'",
      "__mc_precmd",
      "sleep 0.5",
    ].join("\n");
    const r = spawnSync("zsh", ["-c", script], {
      encoding: "utf8",
      env: env({ MC_SNIP: posix(ZSH) }),
    });
    expect(r.status).toBe(0);
    const events = await waitForEvents(4);
    const names = events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["ShellStart", "ShellCommandStart", "ShellCommandEnd", "ShellPrompt"]));
    expect(names.indexOf("ShellCommandStart")).toBeLessThan(names.indexOf("ShellCommandEnd"));
    const start = events.find((e) => e.event === "ShellCommandStart");
    expect(start?.args).toEqual(["--command", "sh"]);
    const end = events.find((e) => e.event === "ShellCommandEnd");
    expect(end?.args.slice(0, 2)).toEqual(["--exit", "3"]);
  });

  it("SH-04 pwsh: ShellStart and ShellPrompt are sent and the original prompt text is preserved", async () => {
    const pwsh = whichOf("pwsh");
    if (pwsh === null) {
      expect(whichOf("pwsh")).toBeNull();
      return;
    }
    const driver = path.join(dir, "driver.ps1");
    writeFileSync(
      driver,
      [
        "function global:prompt { 'MYPROMPT> ' }",
        `. '${PS1}'`,
        "$p = prompt",
        "[Console]::Out.Write('PROMPT=[' + ($p -join '') + ']')",
        "",
      ].join("\n"),
    );
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", driver], {
      encoding: "utf8",
      env: env(),
    });
    expect(r.stdout).toContain("PROMPT=[MYPROMPT> ]");
    const events = await waitForEvents(2);
    const names = events.map((e) => e.event);
    expect(names).toContain("ShellStart");
    expect(names).toContain("ShellPrompt");
  }, 20000);

  it("SH-05 missing shell.env makes every snippet a silent no-op", async () => {
    const missing = path.join(dir, "absent", "shell.env");
    const checks: Array<() => { status: number | null; out: string }> = [];

    if (BASH_EXE !== null) {
      checks.push(() => {
        const r = runBash(BASH_SESSION, { MC_SHELL_ENV: bashPath(missing) });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      });
    }

    const zsh = whichOf("zsh");
    if (zsh !== null) {
      checks.push(() => {
        const r = spawnSync("zsh", ["-c", `source "$MC_SNIP"; sh -c 'exit 3'; true`], {
          encoding: "utf8",
          env: env({ MC_SNIP: posix(ZSH), MC_SHELL_ENV: posix(missing) }),
        });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      });
    }

    const pwsh = whichOf("pwsh");
    if (pwsh !== null) {
      checks.push(() => {
        const driver = path.join(dir, "noenv-driver.ps1");
        writeFileSync(driver, `function global:prompt { 'MYPROMPT> ' }\n. '${PS1}'\n`);
        const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", driver], {
          encoding: "utf8",
          env: env({ MC_SHELL_ENV: posix(missing) }),
        });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      });
    }

    for (const check of checks) {
      const { status, out } = check();
      expect(status).toBe(0);
      expect(out.trim()).toBe("");
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readEvents()).toEqual([]);
  }, 30000);

  it("SH-06 bash, zsh and pwsh: the exporter path is shell-<pid>.jsonl under MC_OTEL_DIR and the folder is created", () => {
    const otel = path.join(dir, "otel");
    writeFileSync(
      envFile,
      `MC_NODE=${posix(process.execPath)}\nMC_HOOK_JS=${posix(hookFile)}\nMC_OTEL_DIR=${posix(otel)}\n`,
    );
    for (const kind of ["bash", "zsh", "pwsh"] as const) {
      const p = probeShell(kind, {});
      if (p === null) continue;
      expect(p.exp).toBe(`${posix(otel)}/shell-${p.pid}.jsonl`);
      expect(existsSync(otel)).toBe(true);
      rmSync(otel, { recursive: true, force: true });
    }
  }, 30000);

  it("SH-07 a preset COPILOT_OTEL_FILE_EXPORTER_PATH is kept, and without MC_OTEL_DIR the variable stays unset", () => {
    const preset = posix(path.join(dir, "mine.jsonl"));
    writeFileSync(
      envFile,
      `MC_NODE=${posix(process.execPath)}\nMC_HOOK_JS=${posix(hookFile)}\nMC_OTEL_DIR=${posix(path.join(dir, "otel"))}\n`,
    );
    for (const kind of ["bash", "zsh", "pwsh"] as const) {
      const p = probeShell(kind, { COPILOT_OTEL_FILE_EXPORTER_PATH: preset });
      if (p === null) continue;
      expect(p.exp).toBe(preset);
    }

    writeFileSync(envFile, `MC_NODE=${posix(process.execPath)}\nMC_HOOK_JS=${posix(hookFile)}\n`);
    for (const kind of ["bash", "zsh", "pwsh"] as const) {
      const p = probeShell(kind, {});
      if (p === null) continue;
      expect(p.exp).toBe("UNSET");
    }
  }, 30000);
});

const PROBE_SH = ['source "$MC_SNIP"', 'echo "PID=$$ EXP=${COPILOT_OTEL_FILE_EXPORTER_PATH-UNSET}"'].join("\n");

/** Drops the exporter variable from the inherited environment unless the test sets it itself. */
function scrubExporter(e: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  if (!("COPILOT_OTEL_FILE_EXPORTER_PATH" in extra)) delete e.COPILOT_OTEL_FILE_EXPORTER_PATH;
  return { ...e, ...extra };
}

/** Sources the snippet in one shell and reports that shell's pid and the exporter path it sees. Null when the shell is not installed. */
function probeShell(kind: "bash" | "zsh" | "pwsh", extra: Record<string, string>): { pid: string; exp: string } | null {
  let out: string;
  if (kind === "bash") {
    if (BASH_EXE === null) return null;
    const r = spawnSync(BASH_EXE, ["-c", PROBE_SH], {
      encoding: "utf8",
      env: scrubExporter(bashEnv({ MC_SHELL_ENV: bashPath(envFile), MC_SNIP: bashPath(BASH) }), extra),
    });
    out = r.stdout;
  } else if (kind === "zsh") {
    if (whichOf("zsh") === null) return null;
    const r = spawnSync("zsh", ["-c", PROBE_SH], {
      encoding: "utf8",
      env: scrubExporter({ ...process.env, MC_SHELL_ENV: posix(envFile), MC_SNIP: posix(ZSH) }, extra),
    });
    out = r.stdout;
  } else {
    if (whichOf("pwsh") === null) return null;
    const driver = path.join(dir, "probe.ps1");
    writeFileSync(
      driver,
      [
        `. '${PS1}'`,
        "$v = [Environment]::GetEnvironmentVariable('COPILOT_OTEL_FILE_EXPORTER_PATH')",
        "[Console]::Out.Write('PID=' + $PID + ' EXP=' + $(if ($null -eq $v) { 'UNSET' } else { $v }))",
        "",
      ].join("\n"),
    );
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", driver], {
      encoding: "utf8",
      env: scrubExporter({ ...process.env, MC_SHELL_ENV: posix(envFile) }, extra),
    });
    out = r.stdout;
  }
  const m = /PID=(\d+) EXP=(.*)/.exec(out.trim());
  if (m === null) throw new Error(`probe ${kind} gave no PID/EXP line: ${out}`);
  return { pid: m[1] ?? "", exp: (m[2] ?? "").trim() };
}
