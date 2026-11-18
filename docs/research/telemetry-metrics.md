# Telemetry metrics for mission-control

Status: research note, revision 2, 2026-11-16. Not a contract. No decision (D-nn) uses it yet.

Revision 2: Woody chose the SDK as the data path (section 3). Section 4.7 adds the SDK
events that revision 1 did not have. Section 9 gives the options to ingest OpenTelemetry.

## 1. Purpose

This note lists the metrics that mission-control can show for each session.
For each metric, it gives what the metric measures and how we get the data.
Section 6 answers a second question: what do people measure when they evaluate a
model on a task, and can we measure that here?

The prose follows ASD-STE100 for about 80% of the text. Names of events, fields and
files stay as the source writes them.

Primary sources: the `@github/copilot-sdk` 1.0.34 package (`dist/types.d.ts`,
`dist/generated/session-events.d.ts`, `dist/generated/rpc.d.ts`), and the vault pages
named in each row. Vault paths are relative to `vault/`.

## 2. Terms

| Term | Meaning |
|---|---|
| Session | One agent or shell session that mission-control shows as a card (`session.schema.json`). |
| Task | One unit of work in a session. Here, a task starts at a user prompt and stops at the next `Stop` hook. |
| AI Credit | The unit that Copilot bills. It replaced premium request units on 2026-06-01. |
| nano-AIU | The unit in which Copilot events report AI Credit cost (`totalNanoAiu`, "Session-wide AI credit cost, in nano-AI units"). |
| Premium request | The old billing unit, before 2026-06-01. Some fields still use this name. |
| Live trace | Data from real work, not from a test set. Most metrics in this note use live traces. |
| Reference | A known correct answer or path. Some evaluation metrics need one. |
| Attach | The daemon resumes a Copilot session through the SDK only to read its events. It sends no prompt. |

## 3. Data sources and the chosen path

### 3.1 Sources

| ID | Source | What it gives | Cost to use | Risk |
|---|---|---|---|---|
| S1 | `~/.copilot/session-state/<id>/events.jsonl` | All Copilot session events, as the session writes them | Low. Read the file, do not write to it. | The file format can change. Rotation can split it into `events.N.jsonl`. |
| S2 | Copilot SDK types | Typed definitions of 198 event types | Low. | The types do not include all on-disk events (for example `session.usage_record`). |
| S3 | **Copilot SDK runtime (chosen)** | Live events through `session.on`, backfill through `getEvents()`, `listSessions()`, `rpc.usage.getMetrics()`, `rpc.quota.get()`, `rpc.account.getQuota()`, `models.list`, `onGitHubTelemetry` | High. The daemon starts its own Copilot runtime. | Attach to a live session is not documented as safe. See 3.3. |
| S4 | Copilot OpenTelemetry export, file or OTLP | Spans for each model call and tool call, and metrics | Medium. It is off by default. | Prompt text is not captured by default. Do not set capture on. |
| S5 | mission-control daemon (hooks and state) | State changes, attention, notifications, restore results, agent PID, for all adapters | Low. The daemon has this data now. | Hooks do not carry token data. |
| S6 | `~/.copilot/session-store.db` and `/chronicle` | An index of sessions and checkpoints | Medium. | It is an internal SQLite file with no contract. |
| S7 | `copilot --usage-output-file` | A JSON usage summary at the end of a non-interactive run | Low, but only for programmatic runs. | Not for sessions that you start in a terminal. |
| S8 | git and the repo gate | Commits, reverts, gate result | Medium. Join on cwd, branch and time. | The join is not exact if two sessions use one branch. |
| S9 | The operating system | CPU and memory of the agent process tree | Low. The daemon knows the agent PID. | Child processes can leave the tree. |

### 3.2 How the daemon uses the SDK

1. The daemon makes one `CopilotClient` with a stdio runtime. Set `COPILOT_CLI_PATH`
   to the installed CLI, so that the runtime and your terminal sessions use one version.
2. Each 30 s, the daemon calls `listSessions()`. It joins each result to a mission-control
   session on `sessionId` = `nativeId`.
3. For each live `copilot-cli` session, the daemon attaches with
   `resumeSession(id, config)`. Use this config:
   - `suppressResumeEvent: true`. The runtime does not write a `session.resume` event.
   - `allowTranscriptRecovery: false`. The runtime does not repair the transcript.
   - `enableSessionTelemetry: false`. The attach sends no GitHub telemetry of its own.
4. The daemon reads old events with `getEvents()` one time. Then it listens with
   `session.on(handler)`.
5. The daemon never sends a prompt, never registers a tool, and never answers a permission.
6. When a session ends, the daemon calls `rpc.usage.getMetrics()` for the final totals.
   Then it disconnects.
7. Each 5 min, the daemon calls `rpc.quota.get()` for plan and allowance data.

### 3.3 Risks of the SDK path, and the spike that must come first

- **Pending work.** `continuePendingWork` is false by default. Then "the runtime treats
  pending work as interrupted on resume". An attach can interrupt a tool call or a
  permission prompt in your terminal. `true` is also not correct: then pending calls
  "wait for caller-supplied results".
- **Two clients.** The docs do not say what happens when two runtimes hold one session.
  The README says only that "Resuming a session only to observe it does not change"
  `lastClientName`.
- **Cost.** The daemon runs one more Copilot runtime process.
- **Stack lock.** `@github/copilot-sdk` is a new runtime dependency (D-01, D-02). It brings
  `zod` 4.6.7, `lossless-json` 4.3.3, `vscode-jsonrpc` 10.0.0, `koffi` 3.3.6 and a
  platform runtime package. Mission-control uses `koffi` now, so check the version.

**Spike (do this before any build task):** start a throwaway Copilot session in a terminal.
Start a tool call that waits for a permission. Attach with the config in 3.2. Make sure
that the terminal session continues, that the permission prompt stays, and that
`events.jsonl` gets no new lines from the attach. If the spike fails, use S1 for live
sessions and attach only after a session ends.

### 3.4 Spike results (2026-11-16, dev-pc)

Spike A tested the attach (3.3). Spike B tested the OTel file. Both ran in the session
scratch folder, with SDK 1.0.34 and runtime and CLI 1.0.112. The scripts and logs are in
`scratchpad/spike-a` and `scratchpad/spike-b`. The owner process in spike A was an SDK
process, not the terminal CLI.

**Attach (spike A):**
- **The attach is safe.** With the 3.2 config and with the defaults, the owner's pending
  permission stayed pending. The owner got no abort, no error and no `session.resume`.
  After approval, the tool ran and a second prompt worked. The attach wrote no line to
  `events.jsonl` and no new file. A `resumeSession` needs no `onPermissionRequest`.
- **The attach gives no live events.** While the owner worked for about 20 s, `session.on`
  in the observer got no event. It got only `session.shutdown`, about 3 s after the owner
  stopped. `getEvents()` gives a snapshot at attach time, one event behind the file.
- **`getEvents()` has no usage.** It omits `session.usage_record`. `assistant.usage` and
  `session.usage_info` are ephemeral: no process writes them to `events.jsonl`.
- **Ended sessions:** `getEvents()` returns the full history except usage. The attach
  writes nothing.
- `lastClientName` was `sdk` for every client, so it cannot show who observed.

**OTel file (spike B):**
- **The file has metrics.** One run gave 2 spans and 13 metrics, all parsed. The metrics
  are 9 histograms (operation and inference duration, input and output tokens, usage
  tokens, cache-write tokens, time to first chunk, agent duration) and 4 counters
  (`gen_ai.invoke_agent.inference_calls`, `gen_ai.invoke_agent.tool_calls`,
  `github.copilot.agent.turn.count`, `github.copilot.mcp.server.connection.count`).
  There is no temporality field.
- **The format is not OTLP.** Each line is a flat Copilot record with `type` `span` or
  `metric`. The parser must follow the Copilot format, and the format can change.
- **`gen_ai.conversation.id` is the session id.** Spans also have `github.copilot.cost`,
  `github.copilot.nano_aiu`, `github.copilot.initiator`, `github.copilot.server_duration`
  and `gen_ai.response.time_to_first_chunk`. No content keys.
- **Most data arrives at the end** of a short run. We do not know yet how often a long
  session writes its metrics.
- **Two processes on one file:** 32 lines, none broken, both sessions present. This was
  one short test only.
- Not tested: rename of the file during a write.

**What `events.jsonl` keeps (checked on the spike sessions):** `session.usage_record` with
50 usage fields (all of TM-01, TM-06, TM-81, plus `toolCounts`, `aiCreditsStatus`,
`contentFilterTriggered`), `session.usage_checkpoint` (`totalNanoAiu`,
`providerModelMetrics`), `permission.requested` and `.completed`, `tool.execution_start`
and `_complete`, turns, `session.model_change` and `session.shutdown`.

### 3.5 The revised data path

The SDK alone cannot give live telemetry for a session that another process owns. Thus:

| Data | Source |
|---|---|
| Live events and all usage | **S1**: the daemon reads new lines of `events.jsonl`, typed with S2. |
| Session list, metadata, quota, plan, prices | **S3**: `listSessions()`, `rpc.quota.get()`, `models.list`. No attach is necessary for these. |
| History of an ended session, if S1 has gaps | **S3**: attach after the end, `getEvents()`. |
| OTel-only metrics (4.8) | **O1**: one file for each source (9.4). |

Context used (TM-03) has no persisted source: `session.usage_info` is ephemeral. Use
`inputTokens / maxPromptTokens` of the last `session.usage_record` as an estimate (see
caveat C3).

## 4. Metric catalogue

Note after the spike: where a row says S3 for an event, read that event from S1 (3.5).
`assistant.usage` rows read the same fields from `session.usage_record`.

Status values:
- **Now**: the data exists. Only parsing and display work is necessary.
- **Build**: we must collect or join new data.
- **Partial**: we can get part of the data, or the data is not exact.
- **No**: we cannot get the data from the sources above.

### 4.1 Model usage (Copilot)

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-01 | Tokens per call | Input, output, cache-read, cache-write and reasoning tokens for each model call | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` on `assistant.usage`. On disk, the same fields are under `usage` in `session.usage_record`. | S3, S1 | Now |
| TM-02 | Token rate | How fast a session uses tokens | Sum TM-01 over a sliding window of 60 s. Show tokens per minute. | S3 | Now |
| TM-03 | Context used | How full the context window is | `currentTokens / tokenLimit` from `session.usage_info`. Show a percent. Show the split: `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`. | S3 | Now |
| TM-04 | AI Credits per session | What the session costs on your plan | `totalNanoAiu` from `rpc.usage.getMetrics()`, `session.usage_checkpoint` or `session.shutdown`. The conversion from nano-AIU to AI Credits is not in the vault. Get it from `models.list` pricing before you show credits. | S3 | Now |
| TM-05 | Model in use | Which model does the work | `model` on each usage event. `newModel` on `session.model_change`. | S3 | Partial: see caveat C4 |
| TM-06 | Model latency | How long the model takes to answer | `timeToFirstTokenMs`, `interTokenLatencyMs` and `duration` on `assistant.usage`. Show p50 and p95 per session. | S3 | Now |
| TM-07 | Errors | How often model calls or the session fail | Count `session.error` and `model.call_failure`. Divide by the count of model calls. Keep `errorType` and `statusCode`. | S3 | Now |
| TM-08 | Compaction | How often the session removes context, and what it costs | Count `session.compaction_complete`. Read `compactionTokensUsed`. | S3 | Partial: see caveat C2 |
| TM-09 | Tool calls per model call | How many tools one model call asks for | `numToolCalls` on `assistant.usage`. Tool duration and failures are in TM-70. | S3 | Now |
| TM-10 | Turns and model calls | How much work one task takes | Count `assistant.turn_start`. Count model calls with `model.call_finished`. | S3 | Now |
| TM-11 | Subagent share | How much of the usage comes from subagents | Group TM-01 and TM-04 by `initiator`. The value is `sub-agent`, or absent for the user. | S3 | Now |
| TM-12 | Code changed | How many lines the session added and removed | `codeChanges` on `session.shutdown`. For each edit, `fileEdits` on `tool.execution_complete`. | S3 | Now |
| TM-13 | API time against wall time | How much time the model works, against total time | `totalApiDurationMs` on `session.shutdown`, against `endedAt - startedAt` from S5. The difference is time in tools or time that waits for you. | S3, S5 | Now, at session end only |
| TM-14 | Quota remaining | How much of your allowance is left | `snapshots` from `rpc.quota.get()`. `budgetMetadata` on `session.quota_observation`. The account call `rpc.account.getQuota()` is experimental. | S3 | Now |

### 4.2 The human loop

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-20 | Time waiting on you | How long a session stops because it needs you | Time from `permission.requested` to `permission.completed`, and from `user_input.requested` to `user_input.completed`. For other agents, use `attention.since` to the next state change. Show the sum per session and the p50 per day. | S3, S5 | Now |
| TM-21 | Interruptions per hour | How often sessions pull you back | Count `permission.requested` and `user_input.requested` per hour. Group by project. | S3, S5 | Now |
| TM-22 | Notification to response | How fast you answer a toast | Time from the OS notification to the next ack, restore or state change. | S5 | Now |
| TM-23 | Restores | How often you go to a session window, and if it works | Count `restore.lastResult`. Group by `status`. | S5 | Now |
| TM-24 | Denied permissions | How often you or a rule refuse an agent action | Count `permission.completed` by `result` kind: `PermissionDeniedInteractivelyByUser`, `PermissionDeniedByRules`, `PermissionDeniedByPermissionRequestHook`, and the others. | S3 | Now. Revision 1 said "No": the SDK closes this gap. |
| TM-25 | Who decided | If a person or a policy answered | `decisionSource` on `permission.completed` (experimental), `actor` on `human_response.recorded`. | S3 | Partial |

### 4.3 The fleet

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-30 | Concurrency | How many agents work at the same time | Count sessions in `working` at each minute. Show the maximum and the time with zero. | S5 | Now |
| TM-31 | Working against idle | How much of a session's life is work | Time in `working`, divided by time from start to end. | S5 | Now |
| TM-32 | Comparison across agents | Copilot against Claude Code against Codex on the same metrics | Group TM-20 to TM-31 by `adapter`. Token metrics need a reader for each agent's own log. | S5 | Now (state metrics), Build (token metrics for Claude Code and Codex) |

### 4.4 Outcome

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-40 | Commits per session | If the session made work that you kept | Count commits on the session branch between `startedAt` and `updatedAt`. | S8 | Build |
| TM-41 | Churn | If the work stayed | The part of those lines that a later commit reverted or rewrote within 7 days. | S8 | Build |
| TM-42 | Gate after session | If the repo still works | The exit code of the repo's gate command, on the last commit of the session. | S8 | Build |
| TM-43 | Verified success | A task that is done and proved | TM-40 > 0 and TM-42 = pass. | S8 | Build |
| TM-44 | Abandoned | A session that made nothing | The session ended with no commit and zero `codeChanges`. | S3, S8 | Build |
| TM-45 | Agent's own result | What Copilot says about the task | `success`, `outcome`, `blocker` and `blockedActions` on `session.task_complete`. This is a judged result, not a verified result. Compare it with TM-43. | S3 | Now |

### 4.5 Cost and allowance

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-50 | Credit burn | How fast you use AI Credits | Sum TM-04 per day, over all sessions. | S3 | Now |
| TM-51 | Month-end projection | If you will go over your allowance | Burn rate from TM-50, times the days left. Compare with the entitlement from TM-14. | S3 | Now |
| TM-52 | Cost in money | What the overage costs | Credits over the allowance, times the price per credit. | none | No: no source gives your plan price. You must type it into the config. |
| TM-53 | Cost per verified task | What one proved result costs | TM-04 divided by the count of TM-43. | S3, S8 | Build |
| TM-54 | Live cost estimate | The cost of a session before the next checkpoint | TM-01 times `billing.tokenPrices` from `models.list` and `models.listTokenPriceUnits`, joined on `modelId`. | S3 | Now |
| TM-55 | Session credit cap | How near a session is to its own limit | `sessionLimits.maxAiCredits`, `session.session_limits_changed`, `session_limits_exhausted.requested` and `.completed`. | S3 | Now |
| TM-56 | Plan context | Which plan and meter apply | `planTier`, `isTbbUser`, `premiumRequestsBillable`, `isFreeUser` from `rpc.quota.get()` (`SessionQuotaProjection`). | S3 | Now |

### 4.6 The machine

| ID | Metric | What it measures | How we measure it | Source | Status |
|---|---|---|---|---|---|
| TM-60 | CPU and memory | Load from each agent and the builds or tests that it starts | Sample the process tree of `process.agentPid` each 10 s. | S9 | Build |
| TM-61 | Attach cost | The load of the daemon's own Copilot runtime | Sample the runtime child process of the `CopilotClient`. | S9 | Build |
| TM-62 | Event log size | How large a session log gets | `eventsFileSizeBytes` on `session.shutdown`. | S3 | Now |

### 4.7 Agent work detail (SDK events)

Revision 1 did not have these metrics. The event names are from `session-events.d.ts`.
Some field lists are not complete; confirm them in the types before a build task.

| ID | Metric | What it measures | How we measure it | Status |
|---|---|---|---|---|
| TM-70 | Tool executions | Count, duration and failures of each tool | `tool.execution_start` to `tool.execution_complete`. Read `error`, `sandboxed`, `isUserRequested`, `model`. Group by tool name. | Now |
| TM-71 | Subagents | What each subagent costs and if it used the model that you set | `subagent.started`, `subagent.completed`, `subagent.failed`. Read `durationMs`, `model`, `cancelled`, `configuredModelMatchesActual`. | Now |
| TM-72 | Rewinds | Work that you or the agent undid | `session.snapshot_rewind`, field `eventsRemoved`. This is a rework signal. | Now |
| TM-73 | Truncation | Context lost when compaction is not enough | `session.truncation`: `preTruncationTokensInMessages`, `postTruncationTokensInMessages`, `messagesRemovedDuringTruncation`. | Now |
| TM-74 | Warnings | Problems that did not stop the session | `session.warning`, group by `warningType`. | Now |
| TM-75 | Rate limits and model faults | Throttling and model trouble | `rate_limit`, `model.call_failure`, `session.model_deselected`, `auto_mode_recovery.outcome`, `auto_mode_switch.completed`. | Now |
| TM-76 | Aborts and end type | Sessions that you stopped or that failed | `abort`. `shutdownType` (`routine` or `error`) and `errorReason` on `session.shutdown`. | Now |
| TM-77 | Per-model and per-agent totals | Usage split by model and by agent | `modelMetrics` and `agentMetrics` on `session.shutdown`. | Now, at session end |
| TM-78 | Skills, MCP and hooks | Which extensions run, and how long hooks take | `skill.invoked`. `session.mcp_server_status_changed`. `hook.start` to `hook.end`, which also measures the cost of the mission-control hook. | Now |
| TM-79 | Context resets | When the session clears or changes its context | `session.context_cleared`, `session.context_changed`. | Now |
| TM-80 | Plan progress | How far the agent is through its plan | `session.plan_changed`, `session.todos_changed`. Fields to confirm. | Partial |
| TM-81 | Request detail | Size, stop reason and route of each call | `requestBodyBytes`, `finishReason`, `maxPromptTokens`, `maxOutputTokens`, `isByok`, `provider`, `isAuto`, `cacheExpiresAt`, `apiCallId` on `assistant.usage`. BYOK calls are not billed by Copilot. | Now |
| TM-82 | Session metadata | Name, repo and client of each session | `summary`, `context.repository`, `context.branch`, `isRemote`, `clientName`, `lastClientName` from `listSessions()`. | Now |
| TM-83 | GitHub telemetry stream | The events that Copilot sends to GitHub, per model call | `onGitHubTelemetry` on `CopilotClient` (experimental). Each event has `kind`, `properties`, `metrics` and `model_call_id`. | Partial: experimental |
| TM-84 | Task classification | Copilot's own label for task outcome, demand and type | `rpc.taskAnalytics.classifyTrajectory` (experimental), eight classifiers such as `task_outcome`. **It sends archive content to GitHub CAPI.** Do not use it on private sessions. | Partial: privacy |

### 4.8 OpenTelemetry only

These metrics need S4. Section 9 gives the ingest options.

| ID | Metric | What it measures | How we measure it | Status |
|---|---|---|---|---|
| TM-90 | Server time against client time | Time in GitHub's service, against total call time | `github.copilot.server_duration` and `gen_ai.response.time_to_first_chunk` on `chat` spans. | Build |
| TM-91 | Inference duration | The distribution of model call time | Histogram `gen_ai.client.inference.duration`. | Build |
| TM-92 | Compaction cost | The tokens that compaction uses | `chat` spans with `github.copilot.request.type = "compaction"`. This fills the gap in caveat C2. | Build |
| TM-93 | Agent turns and tool calls | Counts per agent name, failed calls included | `gen_ai.invoke_agent.inference_calls`, `gen_ai.invoke_agent.tool_calls`. The wiki also names `github.copilot.tool.call.count` and `.duration`; the raw SDK document does not. | Build |
| TM-94 | Cost on the root span | The cost of one agent run | `github.copilot.cost`, `github.copilot.aiu` and `github.copilot.turn_count` on `invoke_agent`. | Build |

## 5. What revision 1 did not have

1. **The billing unit changed.** Copilot bills AI Credits since 2026-06-01, not premium
   requests. `totalPremiumRequests` is a field that remains from the old meter. Use
   `totalNanoAiu` (`wiki/copilot/copilot-sdk-authentication-byok-and-billing.md`, Billing).
2. **The SDK has 198 event types.** Revision 1 used about 10. Section 4.7 adds the rest
   that are useful.
3. **The SDK closes the permission gap.** `permission.completed` gives the result of each
   permission request, denials included (TM-24).
4. **Copilot reports its own task result** in `session.task_complete` (TM-45).
5. **An OpenTelemetry export exists** in the CLI and the SDK (section 9).
6. **Latency fields on each call**: `timeToFirstTokenMs` and `interTokenLatencyMs`
   (`wiki/copilot/copilot-sdk-agent-loop.md`, Event model).
7. **Per-model prices** come from `models.list` (TM-54).
8. **Plan and allowance data** come from `rpc.quota.get()` (TM-14, TM-56).
9. **`/usage` and `/context`** in the CLI show credits, duration, lines and tokens for one
   session (`wiki/copilot/copilot-cli-overview.md`).
10. **`--usage-output-file`** writes a JSON usage summary for programmatic runs
    (`wiki/copilot/copilot-cli-automation-and-protocols.md`, Programmatic mode).
11. **Task analytics** (TM-84) and the **GitHub telemetry stream** (TM-83) exist. Both are
    experimental.

## 6. Evaluation of a model on a task

### 6.1 What people measure

The vault's evaluation pages put the measures in eight groups. The citations are under
`wiki/`.

| Group | Measures | Grader | Needs a reference? | Citation |
|---|---|---|---|---|
| Outcome | Task success from the final state, pass@k (one of k trials passes), pass^k (all k trials pass), rubric score, judged against verified success, abandonment | Code check, LLM judge | Yes for pass@k and rubric. No for verified success and abandonment. | `eval-driven-development/agent-evals.md`, `agent-harness-engineering/anthropic-production-multi-agent-systems.md` |
| Trajectory | Match against a reference tool-call path, a judge score of the path, step checks, the step where a failed run went wrong | Code, LLM judge | Yes for match. No for step statistics. | `eval-driven-development/agent-evals.md`, `langsmith/langsmith-evaluation-experiments.md` |
| Tool use | Tool-call accuracy, tool-call checks | Code, built-in evaluators | Usually yes | `azure-ai/foundry-observability-and-evaluation.md` |
| Efficiency | Steps, turns and tool calls per task, tokens per task, cost per task (p50, p95), latency, error rate | Trace statistics | No | `langfuse/langfuse-token-and-cost-tracking.md` |
| Quality | Binary LLM judge for each failure mode, human labels, pairwise preference, faithfulness, user signals (revert, regenerate) | LLM judge, human | Judges need about 100 labelled examples to calibrate | `langfuse/langfuse-evaluation-methodology.md`, `eval-driven-development/the-practitioner-canon.md` |
| Safety | Refusal pass rate, safety evaluators, red teaming | Evaluators, human | Yes | `azure-ai/foundry-observability-and-evaluation.md` |
| Robustness | Repeated runs, judge reliability (Cohen's kappa), held-out sets | Statistics | Yes | `eval-driven-development/critiques-and-failure-modes.md` |
| Regression | Capability suite against regression suite, baseline deltas, canary scores on live traffic | Any | A fixed set | `eval-driven-development/eval-types-and-methods.md` |

### 6.2 Can we measure it?

Mission-control sees live work, not a test set. Thus it can measure the groups that do
not need a reference. The other groups need a task suite.

| Measure | Can mission-control measure it? | How |
|---|---|---|
| Cost, tokens and turns per task | **Yes** | TM-01, TM-04, TM-10, grouped by task (section 2) |
| Latency, error rate | **Yes** | TM-06, TM-07, TM-75 |
| Tool-call failures | **Yes** | TM-70. This is a reference-free part of "tool use". |
| Human intervention | **Yes**, and it is our strongest measure | TM-20, TM-21, TM-24. The vault pages do not name this as a metric. We add it. |
| Judged success | **Yes** | TM-45, Copilot's own claim |
| Verified success, abandonment | **Yes, after Build** | TM-43, TM-44. The repo gate is the hard signal. Compare with TM-45 to see how often the agent's claim is wrong. |
| User signals (revert, rewrite, rewind) | **Yes** for rewind, **after Build** for revert | TM-72, TM-41 |
| Cost per successful task | **Yes, after Build** | TM-53. The vault pages do not name it either. |
| pass@k, pass^k | **Partial** | Only with a task suite. Run one task k times in clean worktrees, and use the repo gate as the grader. With the SDK, a separate tool can create these sessions and read their events. This is not the daemon's work. |
| Trajectory match | **Partial** | Only with a reference path. The tool-call order is in TM-70. |
| LLM-judge quality | **Partial** | Possible with a local judge on transcripts. The judge needs labelled examples first. Do not use TM-84, because it sends content to GitHub. |
| Safety, red teaming | **No** | Out of scope for a local control plane. |

## 7. Where to keep the data

The daemon keeps the live numbers in memory for the cards. For history and evaluation,
there are two options:

1. **The daemon's own files.** Add the telemetry to the session record. This is simple,
   but it gives no query tools.
2. **Langfuse.** Section 9, option O3.

Recommendation: do option 1 for the cards first. Do option 2 when you want history across
weeks or evaluation scores.

## 8. Caveats on the accuracy of Copilot data

- **C1.** Issue #2774 (closed 2026-10-29): the OTel exporter wrote one model call two times.
  Use a CLI release from after that date. Do not add SDK totals and OTel totals together.
- **C2.** Compaction "does not emit an additional `assistant.usage` event". A total from
  `assistant.usage` misses compaction cost. Use `totalNanoAiu` for cost, and TM-92 for
  compaction tokens.
- **C3.** Issue #2834 is not resolved: we do not know if `inputTokens` includes cache tokens.
  Do not add `cacheReadTokens` to `inputTokens` until we know.
- **C4.** Issue #2856: an unknown model ID can run on a different model, with no
  `model_change` event. TM-05 can show the wrong model. TM-71 shows the same problem for
  subagents through `configuredModelMatchesActual`.
- **C5.** The count of turns is not the count of model calls. Compaction and other runtime
  calls are not turns.
- **C6.** Issue #2809 (open): `session.idle` does not always come after the last usage event.
  Do not close a task total on `session.idle`.
- **C7.** Resolved in revision 2. The SDK's `TelemetryConfig` (`dist/types.d.ts`) confirms
  the environment variables: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
  `COPILOT_OTEL_FILE_EXPORTER_PATH`, `COPILOT_OTEL_EXPORTER_TYPE`, `COPILOT_OTEL_SOURCE_NAME`
  and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`.
- **C8.** OTel data from before the managed telemetry policy resolves can be dropped. Do not
  expect the first spans of a session.
- **C9.** A nonzero `process.exit.code` on a tool span does not mean that the tool failed.

## 9. Options to ingest OpenTelemetry

### 9.1 Where the OTel settings go

The settings must be in the process that runs Copilot:

- **Sessions that the SDK owns.** Set `telemetry` in `CopilotClientOptions`. The SDK sets
  the variables on its own runtime only. It does not change your environment.
- **Sessions that you start in a terminal.** Set the variables in your user environment.
  That changes a real shell profile or the Windows user environment. The orchestrator
  must ask Woody first (`docs/ORCHESTRATION.md` 8).
- **Prompt text.** Keep content capture off. The CLI reference names the variable
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. The SDK sets
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` and a legacy alias. Leave all of them unset.

### 9.2 The options

| ID | Option | How | Good | Bad |
|---|---|---|---|---|
| O1 | File export, the daemon reads the file | `COPILOT_OTEL_EXPORTER_TYPE=file`, `COPILOT_OTEL_FILE_EXPORTER_PATH=<MC_HOME>/otel/copilot.jsonl`. The daemon reads new lines. | No network, no server, no auth. Simplest. | The file grows; the daemon must rotate it. No history UI. |
| O2 | OTLP into the daemon | Add OTLP/HTTP JSON routes (`/v1/traces`, `/v1/metrics`) to the daemon. Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. | Live, no file. `http/json` needs no new dependency. | An API contract change (`api.md`). The exporter must send a token as a header (`OTEL_EXPORTER_OTLP_HEADERS`, documented in `raw/copilot-docs/cli-command-reference.md`). The daemon port must be fixed. |
| O3 | Langfuse, self-hosted | Run the checkout in `tools/langfuse/` with Docker Compose. Send to `/api/public/otel` with Basic Auth (`public_key:secret_key`), `http/json` or `http/protobuf`; Langfuse has no gRPC (`wiki/langfuse/langfuse-opentelemetry-ingestion.md`). | Trace UI, cost from usage, history, and scores for evaluation (section 6). | Large: Docker Compose wants "at least 4 cores and 16 GiB of memory" and about 100 GiB of disk, with Postgres, ClickHouse, Redis and object storage (`wiki/langfuse/langfuse-self-hosting.md`). Langfuse v4 wants the `x-langfuse-ingestion-version: 4` header and the root span. |
| O4 | OpenTelemetry Collector in front | One collector on localhost receives OTLP. It writes to O1, O2 and O3 at the same time, and it can remove attributes before export. | One endpoint for all agents. Redaction in one place. You can add or remove a backend with no Copilot change. | One more process to run and update. The vault does not cover the collector. |
| O5 | A cloud backend (Langfuse Cloud, LangSmith, Azure Monitor) | Set the OTLP endpoint to the vendor. | No server to run. | Data leaves the tailnet: Ask first. Span attributes can contain file paths and tool names, even with content capture off. |
| O6 | A general trace stack (Jaeger, Grafana Tempo with Prometheus) | Send OTLP to the stack. | Good trace and metric UI. | No LLM cost or evaluation features. The vault does not cover these tools. |

### 9.3 Decisions from Woody (2026-11-16)

- **Terminal sessions: yes.** OTel covers Copilot sessions that you start in a terminal.
  This needs the change to your user environment in 9.1. The build task must name the
  exact change, and Woody approves it before it runs.
- **IDE extension sessions: as far as each IDE allows.** See 9.5.
- **Langfuse: no.** O3 is out. O4 is not necessary without a second backend.

### 9.4 O1 against O2: the difference in metrics

**The metrics are the same.** Both options use the same Copilot exporter. Both get the
same spans, the same metric instruments and the same attributes. The CLI reference says
that the file exporter writes "all signals" (`raw/copilot-docs/cli-command-reference.md`).
The SDK type comment says "trace output". Confirm in the spike that metric lines are in
the file. Each span has `gen_ai.conversation.id`, the session identifier. Thus both
options join OTel data to a mission-control session in the same way.

The differences are in which data arrives, and when:

| Topic | O1 (file) | O2 (OTLP into the daemon) |
|---|---|---|
| Daemon is stopped or restarts | The data stays in the file. The daemon reads it when it starts. No gap. | The exporter cannot send. After its retries, it drops the data. Spans from that time are lost. |
| Data from before the daemon started | The daemon can read the old lines. | Not available. |
| Many Copilot processes at one time | All terminal sessions share one path from the user environment. Many processes write to one file. Lines can mix on Windows. To prevent this, use one file for each shell (the `mc` shell integration can set the path with the shell PID). | Each process sends its own requests. No mixing. |
| VS Code | `github.copilot.chat.otel.exporterType = file` and `outfile`. A second file for the daemon to read. | `exporterType = otlp-http` and `otlpEndpoint`. The wire protocol of VS Code is not in the vault. If it is protobuf, the daemon needs a protobuf parser, which is a new dependency. |
| File size | The file grows. On Windows, the daemon cannot rename a file that a writer holds open. Rotation needs care. | No file. |
| Delay | The exporter writes in batches; the daemon reads new lines on a timer. | The exporter sends in batches. A little faster. |
| Security | The file is under `MC_HOME`. No token. | An open local port. The token is in your user environment, where all your processes can read it. |
| Contract change | None for the API. A new config path. | `api.md` (new routes) and a fixed daemon port. |

**Recommendation: O1, with one file for each source.** It loses no data when the daemon
restarts, and mission-control restarts the daemon often. The `mc` shell integration sets
`COPILOT_OTEL_FILE_EXPORTER_PATH=<MC_HOME>/otel/shell-<pid>.jsonl` in each shell. VS Code
writes to `<MC_HOME>/otel/vscode.jsonl`. The SDK runtime writes to
`<MC_HOME>/otel/sdk.jsonl`. The daemon deletes a file when its writer process has ended
and the daemon has read all lines. Use O2 only if the spike shows that the file exporter
does not write metrics.

### 9.5 IDE extension sessions

| IDE surface | Session data through the SDK (S3) | OTel (S4) | Source |
|---|---|---|---|
| VS Code, Copilot through the Agent Host | **Yes.** These sessions are in `~/.copilot/session-state` with `client_name: vscode-agent-host`. On dev-pc on 2026-11-16, one of seven sessions had this client. The Agent Host uses the Copilot SDK since VS Code 1.134. | **Yes.** `github.copilot.chat.otel.enabled`, `exporterType` (`otlp-http`, `otlp-grpc`, `console`, `file`), `otlpEndpoint`, `outfile`, `captureContent` (keep it false). | `wiki/copilot/copilot-vscode-agent-harness.md`, `raw/copilot-docs/vscode-ai-settings.md` |
| VS Code, Copilot CLI in the terminal profile | **Yes.** It is a CLI session. | **Yes**, as a terminal session. | `wiki/copilot/copilot-vscode-agent-harness.md` |
| VS Code, Claude or Codex harness | No. Not a Copilot runtime session. | The `github.copilot.chat.otel.*` settings say "Copilot Chat agent interactions". Not confirmed for these harnesses. | same |
| JetBrains | Not known. The vault does not say where JetBrains keeps sessions. | Only through enterprise managed settings ("centralized OpenTelemetry routing"). A personal account may not have them. | `wiki/copilot/copilot-ide-extensions.md` |
| Visual Studio, Xcode, Eclipse | Not known. | Not known. | none |

Two more points for VS Code:
- Mission-control makes a card from hook events (`ingest.md`). Make sure that the
  `~/.copilot/hooks` file also fires for Agent Host sessions. If it does not, the daemon
  must make a session from `listSessions()`. That is a contract change.
- The VS Code OTel settings are in your user `settings.json`. A change to them is a change
  to your VS Code. The orchestrator must ask Woody first (`docs/ORCHESTRATION.md` 8).

## 10. How to show the data

The mock-up is at https://claude.ai/artifact/BcfRc4LkB2ZzqQHB9uLnt8 (three boards, sample
values only). A change to the board needs a D-nn and an edit of `DESIGN.md`.

### 10.1 The four cards

The cards show the fleet. When you select a session, they show that session only.

| Card | Main value | Second line | Warning |
|---|---|---|---|
| Token rate | TM-02, tokens per minute | The busiest session | none |
| Context used | TM-03 with `≈`, because it is an estimate | The session nearest to full | over 85% |
| AI Credits (replaces "Cost today") | TM-50, credits today | Percent of month and forecast (TM-51) | forecast over 100% |
| Error rate | TM-07, percent of model calls | The most frequent error type | over 5% |

### 10.2 Other places

- **Terrain:** the height of a project is its live token rate (TM-02), not sample data.
- **Header:** one pill with the month use and forecast (TM-51).
- **"Needs you" cards:** one line with credits, context and failed tools.
- **List view:** five new columns, all sortable: AI Credits (TM-04), tokens per minute
  (TM-02), context (TM-03), time waiting on you (TM-20), failed tools (TM-70).
- **Session detail (new):** opens from a card or a list row. It shows six key values, a bar
  for each model call (colour by model, failures and compaction marked), a tool table
  (TM-70), a permission timeline (TM-20, TM-24, TM-25) and subagents (TM-71, TM-11).

### 10.3 Rules for every value

- Show the age of the value ("3 s ago").
- Mark an estimate with `≈`.
- An adapter with no telemetry shows "No data". A shell session shows "n/a".
- Never show sample data next to real data.
- Use colour and lightness together, never colour alone (`--go`, `--look`, `--ink3`).

## 11. Proof that the SDK runtime works on one Windows PC

The proof is one command: `mc doctor copilot`. It prints PASS, FAIL or SKIP for each
check. It exits 1 when a check fails.

| # | Check | PASS when |
|---|---|---|
| D1 | Node | The version is 22.12 or newer (the SDK needs `^20.19.0 \|\| >=22.12.0`; mission-control needs 22). |
| D2 | SDK packages | `@github/copilot-sdk` and its `win32-x64` or `win32-arm64` runtime package are installed, and `koffi` loads. |
| D3 | Runtime start | `client.start()` works and `getStatus()` gives a runtime version and a protocol version. |
| D4 | Version match | The runtime version is the same as `copilot --version`. A difference is a warning, not a FAIL. |
| D5 | Sign-in | The runtime uses the signed-in account with no prompt. |
| D6 | Session list | `listSessions()` gives the same session ids as the folders in `~/.copilot/session-state`. |
| D7 | Quota and prices | `rpc.quota.get()` gives a plan. `models.list` gives prices. |
| D8 | Log files | The newest `events.jsonl` parses. The command reports the count of event types that S2 does not know. |
| D9 | Read-only attach | An attach to an ended session reads its events. The size and hash of its `events.jsonl` do not change. |
| D10 | OTel file (only with `--live`) | One small prompt, with the OTel file set for that child process only. The file has span lines and metric lines with the new session id. This check uses about one AI Credit. |

Where to run it:
- **dev-pc:** all checks.
- **Windows Sandbox** (a clean PC): D5, D7 and D10 are SKIP, because Copilot has no sign-in there.
- **Another PC:** install mission-control, then run `mc doctor copilot`. The failed check
  shows the cause.

Most of the check code exists in the spike scripts (`scratchpad/spike-a`).

## 12. Next steps

Status 2026-11-17: items 2 to 5 are done (T112-T125; D-56, D-57, D-58, D-61). Item 4 also
covers Claude Code sessions, read from their transcripts (D-61). Item 6 is done for Copilot CLI
in a shell with the integration and for VS Code after a window reload. Items 7 and 8 are open.


1. Done: the spike (3.4). The data path is now 3.5. Open checks: the rename test, metric
   write frequency in a long session, an attach to a real terminal CLI session, and the
   hooks for VS Code Agent Host sessions after `mc install copilot` is back.
2. The first build task: `mc doctor copilot` (section 11). Build nothing else before Woody
   approves the mock-up (section 10).
3. Write D-56: `@github/copilot-sdk` as a runtime dependency, and a `telemetry` field on
   `Session` with TM-01 to TM-08, TM-11, TM-20, TM-24 and TM-45.
4. Show TM-02, TM-03, TM-04 and TM-07 on the four cards. Rename "Cost today" to
   "AI Credits".
5. Add TM-20, TM-21 and TM-24 to the list view, and the session detail (10.2).
6. Add O1 (one file for each source, 9.4) and the 4.8 metrics as a later task. It covers
   terminal sessions and VS Code Agent Host sessions (9.5).
7. In the spike, also check two things: that the OTel file has metric lines, and that the
   Copilot hooks fire for VS Code Agent Host sessions.
8. Plan the outcome metrics (4.4) and the task suite (6.2) as separate tasks.
