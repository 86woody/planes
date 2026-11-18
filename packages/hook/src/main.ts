// Entry logic. The 1500 ms deadline is the first statement: the hook never blocks its agent.
const deadline = setTimeout(() => process.exit(0), 1500);
deadline.unref();

import { defaultPaths } from "./paths.js";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runCopilot } from "./copilot.js";
import { runShell } from "./shell.js";
import { logError } from "./send.js";

/** Never writes to stdout, never exits non-zero. Unknown adapters exit 0 silently. */
export async function main(argv: readonly string[]): Promise<void> {
  let paths: ReturnType<typeof defaultPaths> | undefined;
  try {
    paths = defaultPaths();
    switch (argv[2]) {
      case "claude-code":
        await runClaude(paths);
        break;
      case "copilot-cli":
        await runCopilot(argv[3], paths);
        break;
      case "codex":
        await runCodex(argv.slice(3), paths);
        break;
      case "shell":
        await runShell(argv.slice(3), paths);
        break;
      default:
        break;
    }
  } catch (err) {
    if (paths) logError(paths, "internal", err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}
