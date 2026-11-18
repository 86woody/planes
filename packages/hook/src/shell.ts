// ingest.md 6.2: mc-hook shell <Event> [--exit <code>] [--duration-ms <n>] [--command <word>]
import { createHash } from "node:crypto";
import type { Paths } from "./paths.js";
import type { Payload } from "./envelope.js";
import { buildEnvelope, currentChain, cut } from "./envelope.js";
import { deliver, logError } from "./send.js";

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHELL_EVENTS = new Set(["ShellStart", "ShellPrompt", "ShellCommandStart", "ShellCommandEnd", "ShellExit"]);

export async function runShell(args: readonly string[], paths: Paths): Promise<void> {
  const event = args[0];
  if (event === undefined || !SHELL_EVENTS.has(event)) {
    logError(paths, "invalid_event", "shell event is missing or unknown");
    return;
  }
  const payload: Payload = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) break;
    if (flag === "--exit" && /^-?\d+$/.test(value)) payload.exit_code = Number(value);
    else if (flag === "--duration-ms" && /^\d+$/.test(value)) payload.duration_ms = Number(value);
    else if (flag === "--command") {
      const word = value.trim().split(/\s+/)[0];
      if (word) payload.command = cut(word, 80);
    } else continue;
    i++;
  }

  const chain = await currentChain();
  // Shell session id: the shell is the hook's direct parent (ancestry[0]); hashed to 16 [0-9a-f] chars.
  const shell = chain[0];
  const seed = `${shell?.pid ?? process.ppid}-${shell?.startTime ?? ""}`;
  const nativeSessionId = createHash("sha256").update(seed).digest("hex").slice(0, 16);

  if (!EVENT_RE.test(event)) return;
  const envelope = await buildEnvelope({ adapter: "shell", event, nativeSessionId, payload, chain });
  await deliver(envelope, paths);
}
