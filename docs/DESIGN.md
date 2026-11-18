# Design: the Terrain deck

The board is a calm deck of cards around one bold view: a terrain map of the fleet seen
at an angle, where a session's height is its recent activity and a session that needs
you is an orange peak. Every card carries at most one idea. Chosen by Woody as concept
"3C Terrain" (D-48); it replaces the firing room in full. Every element below has a
name, a token and a test (`e2e/design.spec.ts` DS-nn and TR-nn). If an element is not in
this file, it does not go on the page.

**Two signal colours only.** `--go` (green) means fine; `--look` (orange) means needs you
or over a threshold. Nothing else on the page carries a hue (DS-03 checks every computed
colour). An error is orange with a stronger treatment (a ridged peak and a filled
marker), never a third hue. Adapters are mono letter badges, never colours.

**Plain words.** States read Starting, Working, Idle, Needs permission, Needs input,
Error, Done, Ended, Lost, on the page, in notifications (`packages/core/src/notify-policy.ts`)
and in `mc status`. The contract's enums do not change.

**Not this:** mission wording, uppercase labels, a third hue, icon libraries, emoji, a
sidebar of navigation, requests to any other origin.

## 1. Tokens (`packages/ui/src/tokens.css`, verbatim)

Dark warm graphite is the default. Light "bone" applies under
`prefers-color-scheme: light`, and the theme button sets `html[data-theme]` to `dark` or
`light` (stored in `localStorage` as `mc.theme`), which overrides the preference both ways.

```css
:root {
  color-scheme: dark;
  /* surfaces */
  --bg: #0c0b0a;
  --bg2: #161412;
  --card: rgba(30,28,25,.52);
  --solid: #1c1a18;
  --card2: rgba(30,28,26,.94);
  --card3: rgba(40,37,33,.5);
  /* hairlines */
  --hair: rgba(236,230,218,.07);
  --hair2: rgba(236,230,218,.13);
  --hair3: rgba(236,230,218,.26);
  /* ink; --ink3 is the dimmest text (4.5:1 on every surface), --ink4 is never text */
  --ink: #ece7dc;
  --ink2: #a9a398;
  --ink3: #8f897f;
  --ink4: #47433e;
  /* signals */
  --go: #46cf8c;
  --look: #ff8a3b;
  --go-bg: rgba(70,207,140,.09);
  --look-bg: rgba(255,138,59,.08);
  --look-line: rgba(255,138,59,.4);
  --shadow: 0 1px 0 rgba(255,255,255,.03) inset, 0 26px 50px -32px rgba(0,0,0,.95);
  /* terrain canvas */
  --c-ink: #ece7dc;
  --c-ink2: #a9a398;
  --c-ink3: #706b62;
  --c-grid: #ece7dc;
  --c-go: #46cf8c;
  --c-look: #ff8a3b;
  --c-paper: #121110;
  --c-gridk: .22;
  --c-glow: 1;
  /* type */
  --sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, Consolas, monospace;
  /* shape and layout */
  --r: 20px;
  --r-hero: 24px;
  --side: 352px;
  --gap: 16px;
  --tele-h: 138px;
  /* motion */
  --dur: 200ms;
  --pulse: 2400ms;
}

/* light "bone": under prefers-color-scheme: light (unless data-theme="dark"),
   and under :root[data-theme="light"] */
:root {
  color-scheme: light;
  --bg: #e7e2d5;
  --bg2: #efebe1;
  --card: rgba(250,248,242,.62);
  --solid: #f8f5ee;
  --card2: rgba(252,251,247,.9);
  --card3: rgba(236,231,219,.55);
  --hair: rgba(28,30,32,.10);
  --hair2: rgba(28,30,32,.18);
  --hair3: rgba(28,30,32,.32);
  --ink: #1b1d1f;
  --ink2: #4c4d4c;
  --ink3: #6b675e;
  --ink4: #b2ac9e;
  --go: #1a6a43;
  --look: #9c4209;
  --go-bg: rgba(26,106,67,.09);
  --look-bg: rgba(156,66,9,.08);
  --look-line: rgba(156,66,9,.38);
  --shadow: 0 1px 0 rgba(255,255,255,.75) inset, 0 22px 44px -30px rgba(60,44,16,.42);
  --c-ink: #1b1d1f;
  --c-ink2: #4c4d4c;
  --c-ink3: #857f72;
  --c-grid: #2a2724;
  --c-go: #1a6a43;
  --c-look: #b34d0b;
  --c-paper: #f3efe6;
  --c-gridk: .30;
  --c-glow: .55;
}
```

Responsive overrides: `--tele-h: 128px` when the viewport is under 860px tall (and wider
than 760px); `--side: 316px` under 1180px wide.

The text inks and both themes' signal colours were darkened or lightened from the concept
where needed so every text meets 4.5:1 on every surface it sits on (AX-01 runs axe in
both themes).

**Fonts:** Geist (weights 200, 300, 400, 500) and Geist Mono (400, 500), self-hosted from
`@fontsource/geist` and `@fontsource/geist-mono` (OFL-1.1), imported in `main.tsx`.
`vite.config.ts` sets `assetsInlineLimit: 0`: the daemon's CSP is `default-src 'self'`,
so no asset may become a `data:` URL. No font, script, image or style is fetched from any
other origin (DS-10). Numbers use `font-variant-numeric: tabular-nums`. Nothing is
upper-cased by CSS (DS-07).

## 2. Page layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⛰ Mission Control  dev-pc           ●Link ●Notify  20:41  [List L] [Telemetry T] ◐ ? │  header, 40px
├──────────────┬───────────────────────────────────────────────────────────────────────┤
│ Fleet        │ Fleet terrain                                                    (⟲)  │
│ readiness    │ 1 project · height is activity · drag to orbit                        │
│ 38%  ●Needs  │              ●MC-07 Error 01:59                                       │
│ 4 need you   │            /\  ●MC-04 Needs input 01:59   ┌ selected ─────────┐      │
├──────────────┤        /\ /  \      ●MC-05 Done…          │ MC-03 CC Needs …  │      │
│ Needs you 4  │   ════/══\════════════════════            │ Waited 01:59 …    │      │
│ ┌ card ────┐ │        mc-e2e-project 9 sessions          └───────────────────┘      │
│ ┌ card ────┐ │ ●──────────●──────────●──────────○  latest events (dock)              │
│ ┌ card ────┐ │                                                                       │
│ +1 more      │                                                                       │
├──────────────┴─────────┬──────────────┬──────────────┬───────────────────────────────┤
│ Token rate  3s ago     │ Context used │ AI Credits   │ Error rate                    │  telemetry, 138px
└────────────────────────┴──────────────┴──────────────┴───────────────────────────────┘
```

- **Grid** (`.app`): rows `auto minmax(0,1fr) auto`, `height: 100vh; min-height: 800px`,
  `gap: var(--gap)`, padding `16px 24px 20px`. The main row is `var(--side)` then the
  hero (`minmax(0,1fr)`), gap 16px. At 1440x900 the page does not scroll (DS-06).
- **Header** (`<header data-testid="fd-bar">`, 40px): the brand mark (a line-scan glyph,
  `--ink2`), `Mission Control` (Geist 400 17px) and the hostname from `<meta name="mc-host">`
  (`fd-host`, Geist 300 15px `--ink3`). On the right: two compact lamps, `Link`
  (`lamp-link`: go when the WebSocket is open, look otherwise) and `Notify`
  (`lamp-notify`: go when notifications work and a click restores, look when they do not
  or a click cannot restore, hollow when unknown); the local clock `HH:MM` (`fd-met`,
  Geist Mono 12.5px `--ink3`); before it, when the daemon has Copilot account data, the credits
  pill (`credits-pill`, Geist Mono 12.5px `--ink2`, `--look` when the forecast is over 100%):
  "2.50 AIC today · 40% of month · forecast 92%" (D-61; hidden under 760px); the pill buttons `List L` (`btn-list`) and
  `Telemetry T` (`btn-telemetry`), both `aria-pressed`; the theme button (`btn-theme`)
  and the keys button `?` (`btn-help`).
- **Banners** (`data-testid="banner"`, `role="alert"`): a floating card centred under
  the header, `--solid` with a `--look-line` border and an orange dot.
  `data-kind="pairing"` when `/api/state` answers 401: "Pair this browser: run `mc open`
  and enter the code", an input (`pair-input`, placeholder `XXXX-XXXX`) and a primary
  `Pair` button (`pair-submit`); a wrong code shows `pair-error` "Code rejected. Run mc
  open for a new one." `data-kind="los"` after the link has been closed for 3 s, timed
  from the first close ("connecting" does not reset it): "Daemon not reachable.
  Retrying…"; it clears on the next hello. `data-kind="config"` when `daemon.configOk` is
  false: "Config error: <error>". Pairing wins over the others.
- **Phone width** (under 760px): the deck becomes one column (readiness, Needs you, a
  300px terrain, telemetry two by two), the header keeps only the lamp dots and the
  square buttons, the dock hides, pills show only the callsign, and the selected card
  docks to the bottom of the terrain.

## 3. The cards

### Readiness (`data-testid="counts"`, `.card.ready`)

One percentage and one sentence. `readiness` = round(100 × fine / live), where live is
every session not ended (lost counts as live and not fine) and fine is live, not needing
you, not error, not lost (`counts()` in `sort.ts`). Geist 200 68px (58px under 860px
tall), `%` Geist 300 22px `--ink3`. A pill on the right: `Needs you` (look) or
`All clear` (go). The line (`readiness-line`): "4 sessions need you · oldest 01:59" (the
count in `--look`), or "3 live sessions, none waiting on you", or "No live sessions".
`Details` (`readiness-details`, key R) opens a popover (`readiness-pop`): one tick per
live session (go, look, or dashed for lost), then four checks with a 2px bar each:
Daemon link (Open/Down), Needs you, Errored, Restore-capable (`n/live`).

### Needs you (`data-testid="poll"`)

Header "Needs you" with the count (`poll-count`) and a hint `N next`. The stack
(`needsStack()`): every live session with active attention whose current alert was not
dismissed in this page, unacknowledged first, then the longest wait first. At most three
cards, then a link `+N more in the list` (`poll-more`) that opens the list view. With
none: an `all-clear` card, "All clear. Peaks rise here the moment a session asks for you."

**Needs you card** (`<article data-testid="needs-card" data-state data-attention>`,
`.card.nc`, padding 15px 18px 14px; a click selects the session):

| Part | testid | Spec |
|---|---|---|
| callsign | `callsign` | Geist Mono 500 13.5px, `--ink` |
| adapter badge | (`.ad`) | `CC` claude-code, `CX` codex, `CP` copilot-cli, `SH` shell, `GN` generic; Geist Mono 500 10px in a 1px `--hair2` box |
| state | `state-label` | pill; unacknowledged: look with a dot (`data-attention="active"`), the word from section 4 with `Done · review` for done attention; acknowledged: plain pill, no dot |
| waited | `waited` | time since `attention.since`, `MM:SS` (then `H:MM:SS`), Geist 300 26px, `--look` (acknowledged: `--ink2`) |
| message | (`.nc-msg`) | `attention.message`, else `lastEvent.summary`; Geist Mono 12.5px, two lines then clipped |
| Restore | `restore` | section 6 |
| where | (`.where`) | `project · branch`, `--ink3`; replaced by the result (`result`) for 5 s after a restore |
| more | `more` | round 32px button "More actions for <callsign>" opening a menu (`role="menu"`): `Acknowledge A` (`ack`, only when unacknowledged), `Dismiss alert D` (`dismiss-alert`), `Details I` (`details`), `Copy cwd` (`copy-cwd`) |

The selected session's card gets `aria-current="true"` and a `--look-line` border; a
daemon `highlight` message selects that session (and flies the map to it) and marks its
card and row with `data-highlight`.

### Fleet terrain (`<section data-testid="board" data-mode="map|list">`, `.hero`)

The hero card fills the rest of the main row: background `--c-paper`, radius 24px, top
and bottom fades into `--c-paper`. It holds, bottom to top:

- **The canvas** (`data-testid="terrain"`, `tabindex="0"`, an `aria-label` that names
  the gestures and keys). Section 5.
- **Status** (top left): `Fleet terrain` (or the focused project's name) in Geist 300
  18px, and "N projects · height is activity · drag to orbit" (`token rate or activity` while
  the telemetry row is on and a session reports telemetry: such a peak's height is its token rate on a
  log scale, 50k tok/min full; D-61).
- **Reset** (`reset-view`, top right, 36px round): eases the camera home; `data-off="true"`
  (45% opacity) while the view is untouched.
- **Callout pills** (`data-testid="callout"`, `.co`, `data-attention`): one per session
  that needs you or is in error: an orange dot, the callsign (Geist Mono 500 12px), the
  word, the wait in `--look`. Acknowledged: dashed `--hair3` border, hollow dot, wait in
  `--ink3`. Each floats above its peak with a 1px orange leader; placement prefers
  above-right, then the free spot nearest the peak, never under the selected card. A
  click selects. The selected session's own pill hides (its card replaces it).
- **Selected card** (`data-testid="selected"`, `.selc`, 262px): callsign, badge, state
  pill; facts `Waited` (or `Up`), `Last event · age`, `Branch`; `Restore` and a
  `Details` link (or the result for 5 s). It sits beside its peak with a leader line.
- **Dock** (`data-testid="dock"`, bottom): the four latest `lastEvent`s across sessions,
  oldest left: a dot (go, look, or hollow), the `HH:MM` time in Geist Mono and
  "callsign summary".
- **Empty** (`data-testid="empty"`, centred, no live sessions): "No sessions yet", "Start an
  agent with the hooks installed and its peak rises here.", `mc init` and "From a clone:
  `npm run mc -- init`". When only ended sessions remain: "No live sessions" and "N ended
  sessions are in the list (L), under Ended and lost." (D-51).
- **List view** (key L or `btn-list`): replaces the map inside the same card. Below.

### List view (`data-testid="list"`, `.listv`)

"All sessions" with "N · sorted by who needs you · L to close", then a table. Live
sessions first in rank order (`sortSessions()`: needs_permission, error, needs_input,
idle with done attention, working, starting, idle; within a rank `attention.since`
oldest first, then `startedAt` newest first; a dismissed alert moves down). Then the
group "Ended and lost · N" (`<tbody data-testid="splashdown">`) with a `Show`/`Hide`
toggle (`splashdown-toggle`, `aria-expanded`), collapsed by default, newest update first.

Each row is `<tr data-testid="card" data-session data-state data-attention>`; a click
selects:

| Column | testid | Spec |
|---|---|---|
| Session | `callsign`, `host` | callsign (Geist Mono 500), adapter badge, the host below: `VS Code`, `VS Code · Claude`, `Windows Terminal`, `Console`, `Terminal`, `iTerm2`, `WezTerm`, `kitty`, the app name for linux-terminal, `Remote`, `Unknown`; `+ tmux` with a multiplexer |
| State | `state-label` | pill: look for needs_permission, needs_input, error and Done; go for working and idle; no hue for starting, ended, lost; a dot when attention is unacknowledged |
| Waited / up | `elapsed` | waited `MM:SS` when it needs you, else up time `HH:MM:SS` since `startedAt` |
| Project | `project`, `branch` | project, branch below in Geist Mono |
| Attention / last event | `last` | the attention message when it needs you, else `summary · age` |
| Restore | `capability`, `result` | `Full`, `Window only`, `None`, or `Needs access` (macOS permission reasons), with the fix-it text (section 7) as `title`; the result below it for 5 s |
| actions | `restore`, `ack`, `dismiss` | Restore; `Acknowledge` when attention is unacknowledged; `Dismiss` (DELETE) on ended and lost rows |

Ended rows read in `--ink3`.

### Details sheet (key I, `data-testid="sheet"`)

A 400px panel at the right edge, `--solid`, radius 24px: the callsign and badge, the
title, the state pill, the attention message in a `--look-bg` box, then facts (Waited,
Last event, Restore with the last result and the fix-it text, Host, Project, Branch,
Cwd, Uptime, Activity, Session id) and actions (Restore, Acknowledge, Dismiss alert or
Dismiss, Copy cwd).

### Telemetry (`data-testid="telemetry"`, `data-mode="live|wait"`)

D-61: real values only. The row shows on its own once any session reports telemetry (else it is
not rendered and the terrain card takes its height); key T overrides that either way (hide it, or
show it with "No data" cards). Four cards in a row (two under 1180px), 138px tall, for the live
fleet or the selected session:

| Card | Value | Second line | Warning |
|---|---|---|---|
| Token rate | sum of `tokenRate`, tok/min | `busiest <callsign>` (a session: its model) | none |
| Context used | `≈` the highest `context.estimatePct` | `nearest full <callsign>` (a session: of N tokens) | over 85% |
| AI Credits | `copilot.aiCreditsToday` (a session: its `credits.aiCredits`) | `today · N% of month · forecast N%` | forecast over 100% |
| Error rate | 100 × failed / total model calls | `last <error type>`, else `of N calls` | over 5% |

The pill shows the age of the newest value ("3s ago"), or `Over N%` / `Forecast over 100%` in
`--look` with a dot. A card with no source (`.tc.nodata`) shows a dash, the reason ("No data yet",
"n/a", "No context reading yet", "Copilot sessions only", "No live sessions") and the dashed
skeleton in `--ink4`; `data-mode` is `wait` only when all four have none. Sparklines are the
values this page has seen, one sample every 5 s, the newest 48, with a dotted reference line (the
threshold, else the mean); they restart when the scope changes. Never sample data.

A Needs you card with telemetry gets one line under its message (`nc-tele`, Geist Mono 11.5px
`--ink3`): `3.00 credits · ≈88% context · 2 failed tools`, the context and failures in `--look`
when over 85% or above 0.
## 3a. Telemetry views (D-58)

Rules for every telemetry value (research note 10.3): mark an estimate with `≈`; never show
sample data next to real data; colour is never alone (a word, a sign or a position goes
with it). A session with `telemetry` null reads, by adapter: `copilot-cli` and `claude-code` "No data yet",
`shell` "n/a", any other "No data" (`availability()` in `telemetry-format.ts`).

### Routes (`route.ts`)

`location.hash` holds the page: `#/` or empty is the deck; `#/s/<encodeURIComponent(id)>`
the session page; `#/s/<id>/run/<encodeURIComponent(traceId)>` the run trace. An unknown
hash reads as the deck. On a page the header stays and the main row and the telemetry row
are replaced by one full-width card (`.pagev`, `--card` on `--hair`, radius `--r-hero`,
padding 22px 26px, scrolls inside itself). Esc goes up one level (run -> session -> deck);
the browser Back button does the same. `O` (or `sheet-open`, or a row's `open-session`)
opens the selected session's page. On a page J/K open the next or previous session's page
(the same walk as the deck), Enter restores that session, `?` shows the keys; the other
deck keys do nothing.

### List view telemetry columns

After `Waited / up`, five columns, each a header button (`sort-<key>`, `aria-sort` on the
`th`): `Credits` (key `credits`, AI Credits to 2 places, else nano-AIU compact with the
unit), `Tok/min` (`rate`), `Context` (`ctx`, `≈N%`, orange with `Over` word past 85%),
`Waited on you` (`waited`, `MM:SS` of permission plus input wait), `Failed tools`
(`failed`, orange when above 0). Cells carry `data-testid="t-<key>"`. Sessions with no
telemetry show the availability text and sort last whichever way. A click sorts by that
column descending, again ascending, a third time back to "who needs you"; the header line
reads `sorted by <column> ↓|↑`. The five columns hide under 1180px except Credits and
Tok/min; under 760px all five hide. Each live row gets a link `Open` (`open-session`)
before the actions.

So the twelve columns fit at 1440px: while the list is open it takes the whole main row
(`.main.listing`, the side column hides; the list is already ranked by who needs you);
`Attention / last event` is one line with an ellipsis (220px, the full text as `title`); a
branch is cut at 140px; the `Restore` capability column hides under 1600px (the Restore
button and the sheet carry it).

### Session page (`data-testid="session-view"`, `.pagev`)

- **Head:** `← Fleet` (`sv-back`), callsign (Geist Mono 500 20px), adapter badge, state
  pill, the title (`--ink2`), `project · branch`, the model of the newest call, the
  sources (`events`, `otel`, `transcript` as small mono chips) and "updated 3s ago" from
  `telemetry.updatedAt` (`sv-age`). On the right: Restore and `Copy cwd`.
- **No telemetry** (`sv-nodata`): the availability text in Geist 300 26px and one line:
  copilot-cli and claude-code "Telemetry appears after the first model call."; shell "Shell sessions make
  no model calls."; other "This agent has no telemetry source yet." Nothing else below.
- **Key values** (`sv-kpi`, six cards in a row, three under 1180px, two under 760px, each
  `data-k`): `credits` AI Credits; `tokens` input + output (second line `in · out · cache
  read`); `rate` tokens per minute; `ctx` `≈N%` (second line `prompt / max`), orange past
  85%; `calls` model calls (second line `F failed · R rate-limited`, orange when the error
  rate is over 5%); `waited` waited on you (second line `N permission · M input`; with a
  pending request: orange "waiting MM:SS" from its `pendingSince`). Value Geist 200 34px.
- **Model calls** (`sv-calls`): one bar per `recentCalls` entry, oldest left, height
  input + output relative to the largest, 6px wide, 2px gap, 64px tall. Fill by model, in
  order of first use: `--ink`, `--ink2`, `--ink3`, `--go`, then `--ink4`; failed calls are
  `--look` with `data-failed`; subagent calls are 50% opacity. Each bar has a `title`
  "<model> · in N · out N". A legend lists the models with their swatch; a line under it
  "N calls · F failed".
- **Runs** (`sv-runs`): a table from `GET /api/sessions/:id/traces`, newest first,
  fetched on open and every 5 s while the session is live. Columns: Started (`HH:MM:SS`),
  Agent, Duration, Model calls (spans of kind chat), Tools (tool and skill), Tokens (sum of
  chat input + output), Credits (root `nanoAiu`, compact), Status (pill: `Running` when not
  complete, `Error` look, `OK` go). Each row (`sv-run`, `data-trace`) is a link to its run
  trace. States: `Loading runs…`; `Could not load runs (<status>)`; empty "No traces yet.
  Traces come from the Copilot OTel file: `mc install shell`, or the VS Code otel settings."
- **Tools** (`sv-tools`): name, runs, failed (orange above 0), p50, max; most runs first.
- **Permissions and input** (`sv-perms`): requested, approved, denied, pending, total
  wait; input requests and wait; a pending one reads "waiting MM:SS" in orange.
- **Subagents** (`sv-subs`): name, model (with `≠ parent` when `modelMatches` is false),
  duration, `Failed` pill. Hidden when empty.
- **Footer facts** (`sv-facts`): compactions (count, tokens), rewinds, truncations,
  warnings, code changes `+N −M`, task outcome, last error type. A value of 0 or null reads
  `—`.

### Run trace page (`data-testid="run-view"`, `.pagev`)

- **Head:** `← <callsign>` (`rv-back`, to the session page), "Run HH:MM:SS", the agent,
  the duration, the status pill, credits (compact nano-AIU), turns, "N spans".
- **Notes** above the chart, each a `--look-bg` strip: not complete (`rv-open`) "Run in
  progress: the agent span has not arrived yet."; dropped spans (`rv-dropped`) "N spans
  past the 500-span limit are not shown."
- **Waterfall** (`rv-waterfall`): one row per span (`rv-row`, `data-kind`,
  `data-status`, `data-depth`) in tree order: the root, then each span's children by
  start time, depth-first; a span whose parent is not in the run comes after the tree at
  depth 0 with `data-orphan`. Left column 300px: indent 14px per depth, a kind tag (`AG`
  agent, `CH` chat, `CP` compaction, `TL` tool, `SK` skill, `··` other, Geist Mono 10px in
  a box), then the model or tool name, else the span name. Track: a bar from the span's
  start to its end on a shared axis from the run's first start to its last end (an open
  span runs to now, dashed right edge, `data-open`); minimum width 2px; fill by kind:
  agent `--hair3`, chat `--ink2`, compaction `--ink3`, tool and skill `--go`, other
  `--ink4`; status error: `--look` and the word `Error` after the name. Span events are
  2px ticks on the bar with a `title`. Right column 140px: `in N · out N` for chat spans,
  else the duration. Above the track an axis with five ticks (0, 25, 50, 75, 100%) in
  `durationText`.
- **Span detail** (`rv-span`): a click or Enter on a row selects it (`aria-selected`) and
  shows its fields under the chart: name, kind, status, start offset, duration, model,
  tool, tokens, TTFT, server time, events with offsets.
- **Not found** (`rv-missing`): "This run is not in the newest 50 for <callsign>." and the
  back link.
- Under 760px the left column sits above its track.

## 4. The state treatments

| state | word | signal | marker on the terrain | peak |
|---|---|---|---|---|
| starting | Starting | none | dashed `--c-ink2` ring | low (12) |
| working | Working | go | filled green dot, green-dotted crest | 16 + 38 × activity, a slow breathing wobble |
| needs_permission | Needs permission | look | filled orange dot, pulsing orange glow | 88, ridged; 64 once acknowledged |
| needs_input | Needs input | look | as above | as above |
| idle, done attention | Done (`Done · review` on the card) | look | as above | as above |
| idle | Idle | go | green ring | low (7) |
| error | Error | look | filled orange dot and glow, always | 92, ridged |
| ended | Ended | none | not on the map (D-51): the list keeps it under Ended and lost | none |
| lost | Lost | none | dotted ring | flat (3) |

Acknowledged attention: the marker is hollow (paper fill, orange ring), the glow stops,
the card's pill loses its dot and colour, the pill over the peak turns dashed. Orange
scan-line segments trace the slopes of every peak that needs you.

## 5. The terrain (`packages/ui/src/terrain.ts`)

- **Regions are projects** (distinct `project` values, sorted by name): one pad each,
  laid out on a grid (1 pad centred and 25% larger, 2–4 as two columns, 5–9 as three,
  then wider and smaller). Each pad is a faint filled quad with corner brackets and a
  label at its nearest corner: the project name and "N sessions". Sessions take slots on
  their pad in `startedAt` order.
- **Relief**: flat on the pads, rolling between and around them. With more than four pads
  (D-52) they pack into a smaller central area (560 x 400 units instead of 720 x 520) so a
  rolling margin stays around them, and the ramp from flat to rolling follows the narrowest
  gap between pads (90% of it, 14 to 70 units) instead of a fixed 70. A 161×161 grid (5-unit
  step) inside an elliptical mask; a scan line every second row along the axis that
  faces the camera, drawn back to front; each raised run is filled with `--c-paper`
  first, so nearer ridges hide what is behind them (occlusion). Lines fade towards the
  rim and a radial vignette masks the edge.
- **Height** around a session is a Gaussian of its target height (section 4). Activity
  for working sessions is kept client side (`activity.ts`, no contract change): every
  change of `lastEvent.at` or `updatedAt` is timed; activity mixes recency
  (e-folding 90 s) with the change rate over the last two minutes.
- **Colours** come from the `--c-*` tokens, re-read on theme change. Canvas text uses
  Geist and Geist Mono.
- **HiDPI and resize**: the backing store is `devicePixelRatio` (capped at 3) times the
  CSS size; a `ResizeObserver` re-fits the projection and, while the view is untouched,
  the camera.
- **Camera**: target, distance, yaw and pitch, easing towards a target. Pitch is clamped
  to 0.42–1.42 rad, distance to 300–1400, pan to ±320 × ±300.
- **Input, confined to the card**: Pointer Events with pointer capture,
  `touch-action: none` on the hero and canvas, the wheel handler is non-passive and
  prevents the page scroll (TR-01). Drag orbits (with inertia on release); shift-drag or
  right-drag pans; wheel or two-finger pinch zooms; double-click or Reset eases home. A
  press that moves less than 4px is a still click: it selects the nearest peak within
  28px, or clears the selection on empty ground (TR-02). A drag never selects.
- **Selection** from a key or a card flies the camera only when the peak is near the
  edge or hidden, and never under reduced motion.
- The canvas exposes its marker positions as `canvas.mcMarkers` (screen coordinates
  relative to the canvas) for tests and tools.

## 6. Restore (the primary button)

`.btn.pri`: 32px pill, `--ink` face, `--c-paper` text, Geist 500 12.5px, with a `↵` key
hint. Labels: `Restore`; `Restoring…` while the request is in flight (disabled); `Ended`
(disabled) on an ended session; `Copy cwd` when capability is `none`. With capability
`none` no request is sent: the cwd is copied to the clipboard and the result reads
`Focus manually · cwd copied` (CARD-02). Results show for 5 s: `Focused` (go),
`Window only`, `Flashed in the taskbar`, `Failed · <code in words>` (look).

## 7. Fix-it text for `restore.reason` (button title, list tooltip, details sheet)

| reason | text |
|---|---|
| remote_session | `Remote session (SSH). Restore it from the machine it runs on.` |
| no_window_found | `No window found for this session.` |
| wayland_unsupported_compositor | `This Wayland compositor does not let apps focus windows. Focus it manually; cwd copied.` |
| gnome_extension_missing | `Install the "Window Calls" GNOME extension to enable restore.` |
| macos_accessibility_denied | `Grant Accessibility: System Settings > Privacy & Security > Accessibility.` |
| macos_automation_denied | `Grant Automation for this terminal: System Settings > Privacy & Security > Automation.` |
| vscode_bridge_missing | `Install the bridge: npm run mc -- install vscode` |
| vscode_window_unbound | `Click into this VS Code window once so Mission Control can learn it.` |
| tab_not_addressable | `Window comes forward; pick the tab yourself.` |
| multiplexer_detached | `tmux session has no attached client.` |
| process_ended | `Session ended.` |
| platform_error | the `FocusResult.detail` |
| target_elevated | `Running as administrator. Restore cannot bring it forward; switch to it yourself.` |

## 8. Motion

- The terrain eases: camera flights (`1 - e^(-3.2 dt)`), height changes, drag inertia
  (decay 0.93 per 16.7 ms). Peaks that need you pulse their glow; working crests breathe
  ±2.5 units; the selection ring breathes.
- The unacknowledged dot in a Needs you card's pill pulses a ring (`--pulse`, 2400ms,
  ease-in-out); acknowledging stops it (DS-04). Toasts rise in over 250ms.
- `prefers-reduced-motion: reduce`: no CSS or Web Animations at all
  (`document.getAnimations().length === 0`, DS-05), no inertia, no flights, no pulses or
  wobble; the terrain redraws only on change. The cue survives without motion: a Needs you
  card that is unacknowledged keeps a 2px `--look-line` outline, and the pill word, the
  dot and the filled marker remain.

## 9. Accessibility and keys

- Every interactive element shows a 2px focus outline (`--ink2`, offset 2px; the canvas
  insets it) (AX-02, AX-03). Colour is never the only cue: each state has its word, the
  attention dot, a marker shape, and position (the Needs you stack, the list order).
- The list view is the accessible path to every session; the canvas is one focusable
  element with an `aria-label`. Needs you cards are `<article aria-labelledby>` on the
  callsign; list rows are labelled the same way.
- A visually hidden `aria-live` region (`data-testid="announcer"`) says
  "<callsign> <word> <project>" when a session enters attention: `assertive` for
  permission and error, `polite` otherwise (AX-04). Toasts use a polite region.
- axe finds no serious or critical violation on the deck and the list, in both themes
  (AX-01).

| Key | Does |
|---|---|
| J / K | next / previous session (by project, then start time) |
| N | next session that needs you, longest wait first |
| Enter | restore the selected session (not when a button has focus) |
| A | acknowledge the selected session |
| D | dismiss its alert in this page, or delete an ended or lost session |
| I | details sheet |
| O | the selected session's page (D-58) |
| R | readiness details |
| L | list view on and off |
| T | hide or show the telemetry row (D-61) |
| ← → ↑ ↓ | orbit (the map has focus) |
| + / − | zoom |
| 0 | reset the view |
| 1–9 | fly to a project |
| ? | the keys sheet (`data-testid="help"`) |
| Esc | closes the popover, the menu, the sheet, then clears the selection, then leaves the list |

Keys are ignored while typing in an input and with Ctrl, Cmd or Alt held.

## 10. Screenshots

`e2e/design.spec.ts` DS-08 renders the fixture board (one session per row of the section
4 table plus a lost one, all in one project), dark theme, at 1440x900 with reduced motion
and the clock frozen at `2026-11-08T20:41:07`, selects the longest-waiting session with
N, waits for the three remaining pills, and compares to
`e2e/__screenshots__/board-<platform>.png` with `maxDiffPixelRatio: 0.01`. The dock
entries of the ended and lost sessions carry real-clock times and are masked. Baselines
are regenerated only when this file changes.
