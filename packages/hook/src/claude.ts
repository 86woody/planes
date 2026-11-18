// ingest.md section 4: Claude Code hook JSON on stdin -> allowlisted payload.
import type { Paths } from "./paths.js";
import type { Payload } from "./envelope.js";
import { buildEnvelope, currentChain, cut, readCapturePromptText, sanitizeSessionId } from "./envelope.js";
import { deliver, logError } from "./send.js";

const MAX_STDIN = 1 << 20;
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Reads up to 1 MiB; anything beyond is drained and discarded. */
export async function readStdin(): Promise<{ text: string; overflow: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of process.stdin) {
    const b = chunk as Buffer;
    if (size >= MAX_STDIN) {
      overflow = true;
      continue;
    }
    const take = Math.min(b.length, MAX_STDIN - size);
    chunks.push(b.subarray(0, take));
    size += take;
    if (take < b.length) overflow = true;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Builds the payload per ingest.md section 4. Unknown events get only cwd and permission_mode. */
export function buildPayload(input: Record<string, unknown>, event: string, capture: boolean): Payload {
  const out: Payload = {};
  const cwd = str(input.cwd);
  if (cwd !== undefined) out.cwd = cut(cwd, 1024);
  const mode = str(input.permission_mode);
  if (mode !== undefined) out.permission_mode = cut(mode, 32);

  switch (event) {
    case "SessionStart": {
      const source = str(input.source);
      const model = str(input.model);
      if (source !== undefined) out.source = cut(source, 32);
      if (model !== undefined) out.model = cut(model, 64);
      break;
    }
    case "UserPromptSubmit": {
      const prompt = str(input.prompt);
      if (capture && prompt !== undefined) out.prompt = cut(prompt, 200);
      break;
    }
    case "PermissionRequest":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = str(input.tool_name);
      if (tool !== undefined) out.tool_name = cut(tool, 64);
      if (event === "PostToolUseFailure") {
        const err = str(input.error);
        if (err !== undefined) out.error = cut(err, 200);
      }
      break;
    }
    case "Notification": {
      const message = str(input.message);
      const title = str(input.title);
      const type = str(input.notification_type);
      if (message !== undefined) out.message = cut(message, 200);
      if (title !== undefined) out.title = cut(title, 100);
      if (type !== undefined) out.notification_type = cut(type, 48);
      break;
    }
    case "Stop":
    case "SubagentStop": {
      const last = str(input.last_assistant_message);
      if (capture && last !== undefined) out.last_assistant_message = cut(last, 200);
      break;
    }
    case "StopFailure": {
      const code = str(input.error);
      const details = str(input.error_details);
      const combined = details !== undefined && details !== "" ? `${code ?? ""}: ${details}` : code;
      if (combined !== undefined) out.error = cut(combined, 200);
      break;
    }
    case "SessionEnd": {
      const reason = str(input.reason);
      if (reason !== undefined) out.reason = cut(reason, 32);
      break;
    }
    case "SubagentStart": {
      const agentType = str(input.agent_type);
      if (agentType !== undefined) out.agent_type = cut(agentType, 64);
      break;
    }
    default:
      break;
  }
  return out;
}

export async function runClaude(paths: Paths): Promise<void> {
  const { text, overflow } = await readStdin();
  let nativeSessionId: string | undefined;
  let event: string | undefined;
  let input: Record<string, unknown> = {};

  if (overflow) {
    // Over 1 MiB: session and event are taken from the head of the input; payload is {} (ingest.md 4).
    nativeSessionId = /"session_id"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
    event = /"hook_event_name"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logError(paths, "malformed_stdin", "claude-code stdin is not JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logError(paths, "malformed_stdin", "claude-code stdin is not a JSON object");
      return;
    }
    input = parsed as Record<string, unknown>;
    nativeSessionId = str(input.session_id);
    event = str(input.hook_event_name);
  }

  if (nativeSessionId === undefined || nativeSessionId === "" || event === undefined || event === "") {
    logError(paths, "missing_field", "claude-code input has no session_id or hook_event_name");
    return;
  }
  if (!EVENT_RE.test(event)) {
    logError(paths, "invalid_event", "hook_event_name is not a valid event name");
    return;
  }

  const payload: Payload = overflow
    ? {}
    : buildPayload(input, event, readCapturePromptText(paths.configFile));
  const envelope = await buildEnvelope({
    adapter: "claude-code",
    event,
    nativeSessionId: sanitizeSessionId(nativeSessionId),
    payload,
    chain: await currentChain(),
  });
  await deliver(envelope, paths);
}
