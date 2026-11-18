// ingest.md 6.3 and D-36: GitHub Copilot CLI hook JSON on stdin -> the Claude Code event names.
import type { Paths } from "./paths.js";
import type { Payload } from "./envelope.js";
import { buildEnvelope, currentChain, readCapturePromptText, sanitizeSessionId } from "./envelope.js";
import { deliver, logError } from "./send.js";
import { readStdin, buildPayload } from "./claude.js";

const EVENT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Copilot event name (either casing) -> the Claude Code name the reducer matches on. Unlisted names pass through. */
const EVENT_NAMES: Record<string, string> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmitted: "UserPromptSubmit",
  userPromptSubmit: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  agentStop: "Stop",
  permissionRequest: "PermissionRequest",
  notification: "Notification",
};

/** Notification types that differ from Claude Code's: agent_idle is Claude's idle_prompt (SM-14). */
const NOTIFICATION_TYPES: Record<string, string> = { agent_idle: "idle_prompt" };

const first = (...v: unknown[]): string | undefined => v.find((x): x is string => typeof x === "string");

/** Accepts both payload casings (camelCase and snake_case) and returns the snake_case shape buildPayload reads. */
export function normalizeInput(input: Record<string, unknown>, event: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    cwd: first(input.cwd, input.workingDirectory),
    prompt: first(input.prompt),
    source: first(input.source),
    reason: first(input.reason),
    tool_name: first(input.tool_name, input.toolName),
    message: first(input.message),
    title: first(input.title),
  };
  if (event === "SessionStart" && out.source === "new") out.source = "startup";
  const type = first(input.notification_type, input.notificationType);
  if (type !== undefined) out.notification_type = NOTIFICATION_TYPES[type] ?? type;
  const err = input.error;
  out.error = typeof err === "string" ? err : typeof (err as { message?: unknown } | null)?.message === "string" ? (err as { message: string }).message : undefined;
  return out;
}

export async function runCopilot(eventArg: string | undefined, paths: Paths): Promise<void> {
  const { text, overflow } = await readStdin();
  let input: Record<string, unknown> = {};
  if (!overflow) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logError(paths, "malformed_stdin", "copilot-cli stdin is not JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logError(paths, "malformed_stdin", "copilot-cli stdin is not a JSON object");
      return;
    }
    input = parsed as Record<string, unknown>;
  }
  const rawEvent = first(eventArg, input.hook_event_name, input.hookEventName);
  const sessionRaw = overflow
    ? /"session_?[iI]d"\s*:\s*"([^"\\]+)"/.exec(text)?.[1]
    : first(input.session_id, input.sessionId);
  if (rawEvent === undefined || sessionRaw === undefined || sessionRaw === "" || !EVENT_RE.test(rawEvent)) {
    logError(paths, "missing_field", "copilot-cli input has no valid session id or event name");
    return;
  }
  const event = EVENT_NAMES[rawEvent] ?? rawEvent;
  const payload: Payload = overflow
    ? {}
    : buildPayload(normalizeInput(input, event), event, readCapturePromptText(paths.configFile));
  const envelope = await buildEnvelope({
    adapter: "copilot-cli",
    event,
    nativeSessionId: sanitizeSessionId(sessionRaw),
    payload,
    chain: await currentChain(),
  });
  await deliver(envelope, paths);
}
