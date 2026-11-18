// ingest.md 6.1: Codex passes one JSON argument (argv[3]); no stdin.
import { spawn } from "node:child_process";
import type { Paths } from "./paths.js";
import type { Payload } from "./envelope.js";
import { buildEnvelope, currentChain, cut, readCapturePromptText, sanitizeSessionId } from "./envelope.js";
import { deliver, logError } from "./send.js";

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** D-37: Codex's own title-generation thread notifies too; its first input message starts with this. */
const TITLE_PROMPT = "Generate a concise, single-line task title";

/** Starts the wrapped notify program detached with the same single JSON argument. Never throws, never waited on. */
function runChain(encoded: string, arg: string, paths: Paths): void {
  try {
    const argv: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64 || !argv.every((a) => typeof a === "string")) {
      logError(paths, "bad_chain", "codex --chain is not a string array");
      return;
    }
    const [file, ...rest] = argv as string[];
    const child = spawn(file ?? "", [...rest, arg], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (e) => logError(paths, "chain_failed", e.message));
    child.unref();
  } catch (err) {
    logError(paths, "chain_failed", err instanceof Error ? err.message : String(err));
  }
}

/** args: [--chain <base64url JSON argv>] <codex JSON>. The chained program is started first so the deadline cannot cut it. */
export async function runCodex(args: readonly string[], paths: Paths): Promise<void> {
  let chain: string | undefined;
  let rest = args;
  if (rest[0] === "--chain" && rest.length >= 2) {
    chain = rest[1];
    rest = rest.slice(2);
  }
  const arg = rest[rest.length - 1];
  if (chain !== undefined && arg !== undefined) runChain(chain, arg, paths);
  await postCodex(arg, paths);
}

async function postCodex(arg: string | undefined, paths: Paths): Promise<void> {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(arg ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    logError(paths, "malformed_argument", "codex argument is not a JSON object");
    return;
  }

  const type = typeof input.type === "string" ? input.type : undefined;
  const threadId = typeof input["thread-id"] === "string" ? input["thread-id"] : undefined;
  const turnId = typeof input["turn-id"] === "string" ? input["turn-id"] : undefined;
  const sessionRaw = threadId ?? turnId;
  if (type === undefined || !EVENT_RE.test(type) || sessionRaw === undefined || sessionRaw === "") {
    logError(paths, "missing_field", "codex argument has no valid type or thread-id");
    return;
  }

  const firstMsg = Array.isArray(input["input-messages"]) ? input["input-messages"][0] : undefined;
  if (typeof firstMsg === "string" && firstMsg.trimStart().startsWith(TITLE_PROMPT)) return;

  const capture = readCapturePromptText(paths.configFile);
  const payload: Payload = {};
  if (typeof input.cwd === "string") payload.cwd = cut(input.cwd, 1024);
  const last = input["last-assistant-message"];
  if (capture && typeof last === "string") payload.last_assistant_message = cut(last, 200);
  const first = Array.isArray(input["input-messages"]) ? input["input-messages"][0] : undefined;
  if (capture && typeof first === "string") payload.prompt = cut(first, 200);

  const envelope = await buildEnvelope({
    adapter: "codex",
    event: type,
    nativeSessionId: sanitizeSessionId(sessionRaw),
    payload,
    chain: await currentChain(),
  });
  await deliver(envelope, paths);
}
