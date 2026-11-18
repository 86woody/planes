// lastEvent.summary rules, attention.md section 5.

/** Truncate to `max` code points (not UTF-16 units). */
export function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function summarize(adapter: string, event: string, payload: Record<string, unknown>): string {
  return truncate(line(adapter, event, payload), 120);
}

function line(adapter: string, event: string, p: Record<string, unknown>): string {
  if (adapter === "shell") {
    if (event === "ShellCommandStart") return `$ ${str(p.command, "")}`;
    if (event === "ShellCommandEnd") return `${str(p.command, "")} exited ${num(p.exit_code)}`;
    return event;
  }
  if (adapter === "codex") return event === "agent-turn-complete" ? "Turn complete" : event;
  if (adapter !== "claude-code" && adapter !== "copilot-cli") return event;
  switch (event) {
    case "SessionStart":
      return `Session start (${str(p.source, "startup")})`;
    case "UserPromptSubmit":
      return "Prompt";
    case "PreToolUse":
    case "PostToolUse":
      return `Tool: ${str(p.tool_name, "")}`;
    case "PostToolUseFailure":
      return `Tool failed: ${str(p.tool_name, "")}`;
    case "PermissionRequest":
      return `Permission: ${str(p.tool_name, "")}`;
    case "Notification":
      return `Notice: ${str(p.notification_type, "message")}`;
    case "Stop":
      return "Turn complete";
    case "StopFailure":
      return "Turn failed";
    case "SessionEnd":
      return `Session end (${str(p.reason, "other")})`;
    default:
      return event;
  }
}
