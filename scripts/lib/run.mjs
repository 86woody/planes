// Runs gate stages and ad-hoc commands. Plain Node ESM, built-ins only.
import { spawn } from "node:child_process";
import path from "node:path";

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/;
const TAIL_LINES = 30;

// Leading NAME=value tokens become env vars (Windows has no inline env syntax).
export function splitEnv(line) {
  const env = {};
  let rest = line.trim();
  for (let m = ASSIGN.exec(rest); m; m = ASSIGN.exec(rest)) {
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    rest = rest.slice(m[0].length);
  }
  return { env, command: rest };
}

// Commands run with the repo's node_modules/.bin first on PATH (what `pnpm exec` did), so
// `vitest`, `eslint` and `playwright` resolve to the local install and `node`, `npm` still work.
export function withLocalBin(env, cwd) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const bin = path.join(cwd, "node_modules", ".bin");
  return { ...env, [key]: env[key] ? `${bin}${path.delimiter}${env[key]}` : bin };
}

export function runCommand(line, { cwd, env = {} }) {
  const parsed = splitEnv(line);
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks = [];
    const finish = (code) =>
      resolve({
        code,
        ms: Date.now() - started,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    const child = spawn(parsed.command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: withLocalBin({ ...process.env, ...env, ...parsed.env }, cwd),
    });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      chunks.push(Buffer.from(`${err.message}\n`));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export function lastLines(output, n = TAIL_LINES) {
  const lines = output.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-n);
}

// The command list for one stage: its `pre` commands, then the main command with
// the reporter flags the stage kind needs.
export function stageCommands(stage, reportFile) {
  const steps = (stage.pre ?? []).map((cmd) => ({ cmd, env: {} }));
  if (stage.kind === "vitest") {
    steps.push({
      cmd: `${stage.cmd} --reporter=default --reporter=json --outputFile="${reportFile}"`,
      env: {},
    });
  } else if (stage.kind === "playwright") {
    steps.push({
      cmd: `${stage.cmd} --reporter=line,json`,
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
    });
  } else {
    steps.push({ cmd: stage.cmd, env: {} });
  }
  return steps;
}

// gate = { name, root, reportsDir } with reportsDir absolute.
// `<gate>` and `<reports>` in a command are replaced (used by the audit stage).
export async function runStage(stage, gate) {
  const started = Date.now();
  const reportFile = path.join(gate.reportsDir, `${stage.name}.json`);
  const expand = (c) =>
    c.replaceAll("<gate>", gate.name).replaceAll("<reports>", `"${gate.reportsDir}"`);
  let output = "";
  let pass = true;
  for (const step of stageCommands(stage, reportFile)) {
    const r = await runCommand(expand(step.cmd), { cwd: gate.root, env: step.env });
    output += `${r.output}\n`;
    if (r.code !== 0) {
      pass = false;
      break;
    }
  }
  return { pass, ms: Date.now() - started, tail: lastLines(output) };
}
