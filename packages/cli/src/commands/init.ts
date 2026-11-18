import readline from "node:readline";
import type { Io } from "../main.js";
import { type Ctx, type CtxInput, makeCtx, readManifest } from "../installers/manifest.js";
import { installClaude } from "../installers/claude.js";
import { installCopilot } from "../installers/copilot.js";
import { installCodex } from "../installers/codex.js";
import { installUri } from "../installers/uri.js";
import { installVscode } from "../installers/vscode.js";

/** D-46: the agents init can connect, in menu order. */
export const AGENTS = [
  { key: "copilot", label: "GitHub Copilot CLI", manifestKey: "copilot-cli" },
  { key: "claude-code", label: "Claude Code", manifestKey: "claude-code" },
  { key: "codex", label: "Codex", manifestKey: "codex" },
] as const;

/** The pre-selection: Enter at the prompt accepts it. */
export const DEFAULT_AGENTS: readonly string[] = ["copilot"];

const AGENT_KEYS: readonly string[] = AGENTS.map((a) => a.key);
const USAGE = "usage: mc init [--agents copilot,claude-code,codex]";
const USAGE_NO_TERMINAL = "usage: mc init [--agents copilot,claude-code,codex] (no terminal to ask on)";
const EDITORS = ["code", "code-insiders", "cursor"];

/**
 * Accepts `--agents <list>` or `--agents=<list>`. The list is every argument after `--agents`
 * up to the next one starting with `--` (PowerShell splits an unquoted `a,b` into separate
 * words), and each word may itself hold commas. Any other argument is a usage error.
 */
export function parseInitArgs(argv: string[]): { agents: string[] | null } | string {
  if (argv.length === 0) return { agents: null };
  const first = argv[0] ?? "";
  let words: string[];
  if (first === "--agents") words = argv.slice(1);
  else if (first.startsWith("--agents=")) words = [first.slice("--agents=".length), ...argv.slice(1)];
  else return USAGE;
  let end = 0;
  while (end < words.length && !(words[end] ?? "").startsWith("--")) end++;
  if (end < words.length) return USAGE;
  const keys = [
    ...new Set(
      words
        .slice(0, end)
        .flatMap((w) => w.split(/[\s,]+/))
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== ""),
    ),
  ];
  if (keys.length === 0 || keys.some((k) => !AGENT_KEYS.includes(k))) return USAGE;
  return { agents: keys };
}

export interface InitDeps {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  isTTY: boolean;
}

const MENU = [
  "Connect which agents? Type numbers separated by commas; Enter accepts [1].",
  ...AGENTS.map((a, i) => `  ${i + 1}) ${a.label}${DEFAULT_AGENTS.includes(a.key) ? "  (default)" : ""}`),
];

/** Asks for the agents on the given streams. Returns the keys in menu order, or null when the answer never became valid. */
export async function promptAgents(deps: Pick<InitDeps, "stdin" | "stdout">): Promise<string[] | null> {
  const rl = readline.createInterface({ input: deps.stdin, output: deps.stdout, terminal: false });
  const queued: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  const next = (): Promise<string | null> => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
  try {
    deps.stdout.write(`${MENU.join("\n")}\n`);
    for (let attempt = 0; attempt < 3; attempt++) {
      deps.stdout.write("> ");
      const line = await next();
      if (line === null) return null;
      if (line.trim() === "") return [...DEFAULT_AGENTS];
      const tokens = line.split(/[\s,]+/).filter((t) => t !== "");
      const picked = new Set<string>();
      let valid = true;
      for (const t of tokens) {
        const n = /^\d+$/.test(t) ? Number(t) : NaN;
        const agent = AGENTS[n - 1];
        if (agent === undefined) {
          valid = false;
          break;
        }
        picked.add(agent.key);
      }
      if (valid) return AGENTS.filter((a) => picked.has(a.key)).map((a) => a.key);
      deps.stdout.write(`not a choice: ${line}\n`);
    }
    return null;
  } finally {
    rl.close();
  }
}

interface Captured {
  io: Io;
  out: string[];
  err: string[];
}

function captured(io: Io): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s), env: io.env, cwd: io.cwd }, out, err };
}

interface Result {
  status: string;
  ok: boolean;
}

/** Runs one installer with a fresh captured ctx and maps its exit code to installed, repaired or failed. */
async function runInstaller(io: Io, input: Partial<CtxInput>, manifestKey: string, call: (ctx: Ctx) => Promise<number>): Promise<Result> {
  const cap = captured(io);
  const ctx = makeCtx(cap.io, { ...input, dryRun: false });
  try {
    const had = readManifest(ctx)[manifestKey] !== undefined;
    const code = await call(ctx);
    if (code === 0) return { status: had ? "repaired" : "installed", ok: true };
    const first = cap.err.join("").split(/\r?\n/).find((l) => l.trim() !== "");
    return { status: `failed (${first ?? `exit ${code}`})`, ok: false };
  } catch (err) {
    return { status: `failed (${(err as Error).message})`, ok: false };
  }
}

export async function run(argv: string[], io: Io, input: Partial<CtxInput> & Partial<InitDeps> = {}): Promise<number> {
  const parsed = parseInitArgs(argv);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n`);
    return 2;
  }
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const isTTY = input.isTTY ?? process.stdin.isTTY === true;

  let selected = parsed.agents;
  if (selected === null) {
    if (!isTTY) {
      // D-53: unattended init (a script, CI, piped input) connects the default agent, as Enter would.
      selected = [...DEFAULT_AGENTS];
      const names = AGENTS.filter((a) => DEFAULT_AGENTS.includes(a.key)).map((a) => a.label);
      io.out(`No terminal to ask on: connecting ${names.join(", ")} (the default). Use --agents to choose.`);
    }
  }
  if (selected === null) {
    const picked = await promptAgents({ stdin, stdout });
    if (picked === null) {
      io.err(`${USAGE_NO_TERMINAL}\n`);
      return 2;
    }
    selected = picked;
  }

  const probe = makeCtx(io, { ...input, dryRun: false });
  let anyAgentFailed = false;

  const chosen: string[] = selected;
  for (const agent of AGENTS.filter((a) => chosen.includes(a.key))) {
    const call = agent.key === "copilot" ? installCopilot : agent.key === "claude-code" ? installClaude : installCodex;
    const r = await runInstaller(io, input, agent.manifestKey, call);
    if (!r.ok) anyAgentFailed = true;
    io.out(agent.key.padEnd(12) + " " + r.status);
  }

  if (probe.platform === "win32" || probe.platform === "linux") {
    let r: Result;
    if (probe.env.MC_HOME) r = { status: "skipped (MC_HOME set)", ok: true };
    else r = await runInstaller(io, input, "uri-handler", (ctx) => installUri(ctx, false));
    io.out("uri-handler".padEnd(12) + " " + r.status);
  }

  let editorOnPath = false;
  for (const editor of EDITORS) {
    if (await probe.onPath(editor)) {
      editorOnPath = true;
      break;
    }
  }
  const vscode: Result = editorOnPath
    ? await runInstaller(io, input, "vscode", (ctx) => installVscode(ctx))
    : { status: "skipped (no editor on PATH)", ok: true };
  io.out("vscode".padEnd(12) + " " + vscode.status);

  if (!anyAgentFailed) io.out("next: mc launch");
  return anyAgentFailed ? 1 : 0;
}
