import type { Io } from "../main.js";
import { makeCtx, type CtxInput } from "../installers/manifest.js";
import { installClaude } from "../installers/claude.js";
import { installCopilot } from "../installers/copilot.js";
import { installCodex } from "../installers/codex.js";
import { installShell, type ShellKind } from "../installers/shell.js";
import { installUri } from "../installers/uri.js";
import { installAutostart } from "../installers/autostart.js";
import { installVscode } from "../installers/vscode.js";

export const INSTALL_TARGETS = ["claude-code", "codex", "copilot", "shell", "uri-handler", "autostart", "vscode"] as const;

export interface InstallArgs {
  target: string;
  dryRun: boolean;
  direct: boolean;
  shell: ShellKind | null;
}

/** Parses `<target> [--dry-run] [--direct] [--pwsh|--bash|--zsh]`; returns an error message on bad input. */
export function parseInstallArgs(argv: string[]): InstallArgs | string {
  const args: InstallArgs = { target: "", dryRun: false, direct: false, shell: null };
  const shells: ShellKind[] = [];
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--direct") args.direct = true;
    else if (a === "--pwsh" || a === "--bash" || a === "--zsh") shells.push(a.slice(2) as ShellKind);
    else if (a.startsWith("-")) return `unknown flag ${a}`;
    else if (args.target === "") args.target = a;
    else return `unexpected argument ${a}`;
  }
  if (!(INSTALL_TARGETS as readonly string[]).includes(args.target)) {
    return `usage: mc install <${INSTALL_TARGETS.join("|")}> [--dry-run] [--direct] [--pwsh|--bash|--zsh]`;
  }
  if (args.target === "shell") {
    if (shells.length !== 1) return "mc install shell needs exactly one of --pwsh, --bash, --zsh";
    args.shell = shells[0] ?? null;
  } else if (shells.length > 0) {
    return `--pwsh/--bash/--zsh apply to shell only`;
  }
  if (args.dryRun && args.target !== "claude-code" && args.target !== "copilot") return "--dry-run is implemented for claude-code and copilot only";
  return args;
}

export async function run(argv: string[], io: Io, input: Partial<CtxInput> = {}): Promise<number> {
  const parsed = parseInstallArgs(argv);
  if (typeof parsed === "string") {
    io.err(`${parsed}\n`);
    return 2;
  }
  const ctx = makeCtx(io, { ...input, dryRun: parsed.dryRun });
  try {
    switch (parsed.target) {
      case "claude-code":
        return await installClaude(ctx);
      case "codex":
        return await installCodex(ctx);
      case "copilot":
        return await installCopilot(ctx);
      case "shell":
        return await installShell(ctx, parsed.shell as ShellKind);
      case "uri-handler":
        return await installUri(ctx, parsed.direct);
      case "autostart":
        return await installAutostart(ctx);
      case "vscode":
        return await installVscode(ctx);
      default:
        return 2;
    }
  } catch (err) {
    io.err(`mc install ${parsed.target}: ${(err as Error).message}\n`);
    return 1;
  }
}
