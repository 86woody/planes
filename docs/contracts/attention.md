# Contract: the attention state machine and notify policy

Status: FROZEN at plan freeze. Implemented in `packages/core/src/attention.ts`
(reducer, T010) and `packages/core/src/notify-policy.ts` (T011). Every row ID below is
a test name: the test file contains a test whose title starts with that ID.

## 1. Reducer signature

```ts
// packages/core/src/attention.ts (illustrative; the types come from @mc/contracts)
export interface ReducerOptions {
  doneIsAttention: boolean;      // config notifications.on.done (default true)
  capturePromptText: boolean;    // config sessions.capturePromptText
  shellNotifyAfterSeconds: number; // config adapters.shell.notifyAfterSeconds (default 60)
}
export type CoreEvent =
  | { kind: "ingest"; envelope: IngestEnvelope; receivedAt: number }
  | { kind: "process_exited"; sessionId: SessionId; at: number }
  | { kind: "lost_timeout"; sessionId: SessionId; at: number }
  | { kind: "ack"; sessionId: SessionId; at: number }
  | { kind: "restore_result"; sessionId: SessionId; result: FocusResult; ackOnRestore: boolean }
  | { kind: "notified"; sessionId: SessionId; at: number };
export interface SessionCursor { lastAppliedSentAt: number }  // daemon-internal
export function reduce(
  prev: { session: Session; cursor: SessionCursor } | undefined,
  ev: CoreEvent,
  opts: ReducerOptions,
  alloc: { nextCallsign(): string },
): { session: Session; cursor: SessionCursor; changed: boolean } | undefined;
```

`undefined` result = the event does not create a session (e.g. `ack` for an unknown id).
`changed` is true when any public field changed. The reducer is pure: no clock, no I/O;
times come from the event (`sentAt` for ingest, `at` otherwise), formatted as RFC 3339
UTC with milliseconds.

Session-level fields set on every applied ingest event: `updatedAt`, `lastEvent`,
`stats.events += 1`, `cwd` and `project` when `payload.cwd` is present (project =
basename of cwd; the daemon later overwrites `project` and `branch` from git, which
is not the reducer's job), `process.agentPid` from `origin.agent.pid` when non-null.
`host` and `restore` are **not** set by the reducer (the daemon sets them from
classification and target resolution); a newly created session gets
`host = classifyHost(origin)` and `restore = {capability: "none", reason: null,
lastResult: null}`.

## 2. Claude Code transitions (table 1)

"Live" = state not in {ended, lost}. "Clear attention" = `attention = {active: false,
reason: null, since: null, acknowledged: false, message: null}`. "Set attention R, M" =
`{active: true, reason: R, since: <event time>, acknowledged: false, message: M}`;
if attention is already active with the same reason, only `message` is updated
(since and acknowledged are kept).

| ID | From | Event (payload condition) | To state | Attention | Other |
|---|---|---|---|---|---|
| SM-01 | none | SessionStart (`source` startup or absent) | starting | clear | create; callsign allocated |
| SM-02 | none | SessionStart (`source` resume, clear, compact, fork) | idle | clear | create |
| SM-03 | ended or lost | SessionStart (any source) | starting if source startup, else idle | clear | `endReason = null` |
| SM-04 | live | SessionStart `source: compact`, `resume` or `fork` | unchanged | unchanged | |
| SM-05 | live | SessionStart `source: clear` or `startup` | starting | clear | `stats` kept |
| SM-06 | live | UserPromptSubmit | working | clear | `stats.prompts += 1`; if it is the first prompt and capturePromptText, `title = prompt` truncated to 80 |
| SM-07 | none | UserPromptSubmit | working | clear | create, as SM-06 |
| SM-08 | live, not in {needs_permission, needs_input} | PreToolUse | working | clear if the active reason is `done` or `error`, else unchanged | |
| SM-09 | needs_permission or needs_input | PreToolUse | unchanged | unchanged | |
| SM-10 | live | PostToolUse or PostToolUseFailure | working | clear | `stats.tools += 1` |
| SM-11 | live | PermissionRequest | needs_permission | set permission, `"Permission: " + tool_name` | |
| SM-12 | live | Notification `permission_prompt` | needs_permission | set permission, `payload.message` | |
| SM-13 | live, attention active with reason done | Notification `idle_prompt` | unchanged | unchanged | (the done attention already covers it) |
| SM-14 | live, otherwise | Notification `idle_prompt` | needs_input | set input, `payload.message` | |
| SM-15 | live | Notification `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | needs_input | set input, `payload.message` | |
| SM-16 | live | Notification of any other type, or no type | unchanged | unchanged | lastEvent updated |
| SM-17 | live | Stop | idle | doneIsAttention ? set done, `last_assistant_message` or "Turn complete" : clear | |
| SM-18 | live, not in {needs_permission, needs_input} | SubagentStart, SubagentStop, PreCompact, PostCompact | working | clear if the active reason is `done` or `error`, else unchanged | |
| SM-19 | live | StopFailure | error | set error, `payload.error` or "Turn failed" | |
| SM-20 | any | SessionEnd | ended | clear | `endReason = payload.reason` if in the enum, else `other`; `process.alive = false` (D-38) |
| SM-21 | live | `process_exited` | ended | clear | `endReason = process_exit`, `process.alive = false` |
| SM-22 | live | `lost_timeout` | lost | clear | `endReason = lost` |
| SM-23 | any with active attention | `ack` | unchanged | `acknowledged = true` | no-op (changed=false) if inactive |
| SM-24 | any | ingest with `sentAt < cursor.lastAppliedSentAt` | unchanged | unchanged | only `stats.events += 1`; except SessionEnd, which always applies |
| SM-25 | ended with `endReason` process_exit or lost | any ingest (not SessionStart) with newer sentAt | per the live row for that event | per that row | `endReason = null`, `process.alive = true` |
| SM-26 | ended with any other endReason | any ingest except SessionStart | unchanged | unchanged | lastEvent updated |
| SM-27 | any | `restore_result` | unchanged | if `ackOnRestore` and result.status != failed and attention active: `acknowledged = true` | `restore.lastResult = result` |
| SM-28 | none | any other ingest event (not SessionStart/UserPromptSubmit) | working, then the event's live row applied | per row | create (Claude Code started before mission control) |
| SM-38 | any | `notified` | unchanged | unchanged | `stats.notifications += 1`; `updatedAt` unchanged; changed=true |

Rows are checked top to bottom; the first match wins. Unknown event names fall into
SM-16 semantics (no state change). `cursor.lastAppliedSentAt = max(previous, sentAt)`
after any applied ingest.

### 2.1 Known blind spot: between a permission answer and the next event (round 1, F17)

Claude Code fires `PreToolUse` **before** the permission check and fires nothing when
Woody answers the prompt. After a grant, the next event is the tool's `PostToolUse`
(or `PostToolUseFailure`); after a denial in the dialog, it is whatever Claude does
next (usually `Stop` or another tool). So a long approved tool (a 10-minute build) keeps
the session in `needs_permission` until it finishes. This is accepted for v1 and
shown honestly instead of guessed: once the attention is acknowledged (ACK, or
RESTORE with `ackOnRestore`), the card uses the acknowledged GO/NO-GO treatment of
DESIGN.md 4 (steady, label `GO/NO-GO · ACK`), and no further notification is sent for
it. `PermissionDenied` is not hooked: it reports auto-mode classifier denials, not
answers in the dialog. Revisit if Claude Code adds a permission-answered event.

## 3. Ordering

Async hooks may arrive out of order (D-03). SM-24 makes the reducer keep the newest
state. `sentAt` is the hook **process start time** (`ingest.md` 3), not the time the
envelope was finished: hook start-up takes 60-300 ms with jitter larger than the gap
between two events (PostToolUse then Stop), so a build-time stamp would invert their
order and SM-24 would drop the Stop. Two events with equal `sentAt` apply in arrival order.

## 4. Other adapters (table 3)

| ID | Adapter | Event | Treated as Claude Code row |
|---|---|---|---|
| SM-30 | codex | agent-turn-complete | SM-28 create if none (state idle), then SM-17 |
| SM-31 | shell | ShellStart | SM-01 |
| SM-32 | shell | ShellCommandStart | SM-06 (no prompt text; `stats.prompts` counts commands) |
| SM-33 | shell | ShellCommandEnd with `duration_ms >= notifyAfterSeconds*1000` | SM-17 with message `"<command> exited <exit_code>"`; exit_code != 0 -> SM-19 instead |
| SM-34 | shell | ShellCommandEnd shorter | idle, attention clear |
| SM-35 | shell | ShellPrompt | idle, attention unchanged |
| SM-36 | shell | ShellExit | SM-20 with reason `other` |
| SM-39 | copilot-cli | SessionStart, UserPromptSubmit, PermissionRequest, Notification, PostToolUse, PostToolUseFailure, Stop, SessionEnd | the Claude Code row of the same name (SM-01..SM-20): the hook sends Claude names, `agent_idle` arrives as `idle_prompt` (SM-13/SM-14); summaries use section 5 |
| SM-37 | generic | Start / Working / NeedsInput / NeedsPermission / Done / Error / End | SM-01 / SM-10 / SM-15 / SM-12 / SM-17 / SM-19 / SM-20 |

`notifyAfterSeconds` is passed in `ReducerOptions` as `shellNotifyAfterSeconds`
(default 60).

## 5. `lastEvent.summary` rules

| Event | Summary |
|---|---|
| SessionStart | `Session start (<source>)` |
| UserPromptSubmit | `Prompt` (never the prompt text) |
| PreToolUse / PostToolUse | `Tool: <tool_name>` |
| PostToolUseFailure | `Tool failed: <tool_name>` |
| PermissionRequest | `Permission: <tool_name>` |
| Notification | `Notice: <notification_type or "message">` |
| Stop | `Turn complete` |
| StopFailure | `Turn failed` |
| SessionEnd | `Session end (<reason>)` |
| codex agent-turn-complete | `Turn complete` |
| shell events | `$ <command>` for CommandStart, `<command> exited <code>` for CommandEnd, else the event name |
| anything else | the event name |

Truncate to 120 code points.

## 6. Notify policy

```ts
// packages/core/src/notify-policy.ts (illustrative)
export interface NotifyContext {
  config: Config["notifications"];
  now: number;                                   // epoch ms
  localMinutes: number;                          // minutes since local midnight, for quiet hours
  isForeground: boolean;                         // platform says this session's window is foreground
  lastSent: { reason: AttentionReason; at: number } | undefined; // for this session
}
export type NotifyDecision =
  | { send: true; notification: OsNotification }
  | { send: false; why: "disabled" | "reason_disabled" | "no_change" | "acknowledged"
      | "focused" | "quiet_hours" | "dedupe" | "ended" };
export function decide(prev: Session | undefined, next: Session, ctx: NotifyContext): NotifyDecision;
export function decideRenotify(s: Session, ctx: NotifyContext): NotifyDecision; // tick, every 30 s
export class Coalescer { /* section 6.2 */ }
```

### 6.1 Rules for `decide` (checked in order; the first that applies decides)

| ID | Condition | Decision |
|---|---|---|
| NP-01 | `config.enabled` false | `disabled` |
| NP-02 | `next.state` in {ended, lost} | `ended` |
| NP-03 | `next.attention.active` false | `no_change` |
| NP-04 | prev attention active with the same reason as next | `no_change` |
| NP-05 | `config.on[next.attention.reason]` false | `reason_disabled` |
| NP-06 | `next.attention.acknowledged` true | `acknowledged` |
| NP-07 | `ctx.lastSent` has the same reason and `now - at < 10000` | `dedupe` |
| NP-08 | `config.suppressWhenFocused` and `ctx.isForeground` | `focused` |
| NP-09 | `config.quietHours` set and `localMinutes` within it (start inclusive, end exclusive, may wrap midnight) and reason is not `permission` | `quiet_hours` |
| NP-10 | otherwise (attention became active, or its reason changed) | `send` |

### 6.2 Renotify and coalescing

| ID | Rule |
|---|---|
| NP-11 | `decideRenotify`: if `config.renotifyMinutes > 0`, attention active, not acknowledged, reason enabled, not focused, not quiet, and `now - lastSent.at >= renotifyMinutes*60000`: send. Otherwise not. |
| NP-12 | `Coalescer.offer(n, now)`: at most 3 notifications pass within any 5000 ms window; further ones are held; when the window closes, held ones become one summary notification with `sessionId: null`, title `MISSION CONTROL`, body `"<k> sessions need attention"`, and the most urgent held urgency. `Coalescer.flush(now)` returns what is due. |

### 6.3 Notification content

| ID | Rule |
|---|---|
| NP-13 | `title = "<callsign> · <LABEL> · <project>"` where LABEL is the DESIGN.md state label (GO/NO-GO, HOLD, ANOMALY, NOMINAL). `body = attention.message` or the default: permission "Permission needed", input "Waiting for your input", error "Turn failed", done "Turn complete". Both truncated (title 64, body 180 code points). `urgency`: permission and error `critical`, input `normal`, done `low`. `sessionId = next.id`. |
| NP-14 | `OsNotification` shape: `{ sessionId: SessionId | null, title, body, urgency: "low"|"normal"|"critical", tag: sessionId ?? "summary" }` (`tag` lets the OS replace an older notification for the same session). |
