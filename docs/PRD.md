# PRD: Mission Control

Status: planning, draft for review round 1. Owner: Woody. Date: 2026-11-08.

## 1. Problem

Woody runs many agent sessions at once (Claude Code in several VS Code windows and
terminals, sometimes Codex or Copilot CLI) across one Windows workstation and, at
times, Linux and macOS machines. A session that is blocked on a permission prompt or
waiting for input sits unnoticed in a background window or a hidden terminal tab.
Finding it means hunting through windows and tabs. The cost is idle agents and lost
continuity.

## 2. The ask (verbatim)

> A control plane with a theme of a mission control for a rocket launch. I should be
> able to view all the sessions running on my computer on a browser. Each one gets its
> own card with a restore button which maximizes it regardless if it's running on VS
> Code or a shell. When a session running on my machine needs my attention it should
> notify via the notifications of the OS. It should work for Windows, Linux, and Macs.

## 3. Users

One: Woody, a solo AI engineer, at the machine, with a browser tab open on the
mission-control page, often on a second monitor. No multi-user, no remote viewers.

## 4. Goals

- G1. One browser page lists every live agent session on this machine as a card.
- G2. One click on a card's RESTORE brings that session's window to the foreground,
  maximized, with the right terminal tab or VS Code terminal selected.
- G3. A session entering an attention state raises one OS notification; clicking it
  restores the session.
- G4. Works on Windows 11, macOS 13+, Linux X11, and the Linux Wayland compositors in
  `docs/platforms/linux.md`, with explicit, visible degraded behaviour where the OS
  forbids an action.
- G5. A mission-control visual identity specific enough that it cannot be mistaken
  for a generic dashboard (`docs/DESIGN.md`).
- G6. Local only. Nothing is sent off the machine. No account, no cloud.

## 5. Non-goals (v1)

- Controlling sessions: no approving permissions, no typing into sessions, no killing
  sessions from the page. RESTORE takes you to the session; you act there. (Atlas
  parked "permission prompts routed to the page" for the same reason.)
- Remote machines. Each machine runs its own daemon; there is no aggregation across
  machines. SSH sessions are shown but cannot be restored (D-17).
- Showing terminal output or transcripts. Cards show metadata and the last event.
- SEA single binaries, signing and notarization, auto-update and package-manager listings
  (D-45). v1 ships an npm tarball, `mission-control-desktop` (D-39), installed with
  `npm i -g`, `mc init`, `mc launch` (D-46).
- Sessions inside WSL on Windows, unless WSL can reach `127.0.0.1` of the host
  (mirrored networking). Otherwise they are invisible (open question Q3).
- Mobile, phone push (ntfy exists for that; integration is a later option).
- Plain shells with no agent, unless the opt-in shell integration is installed (D-18).

## 6. Assumptions (stated so the reviewer can attack them)

- A1. "Sessions" means AI agent sessions first. Claude Code is first-class because it
  has hooks. Codex CLI (its `notify` program) and opt-in shell integration are the
  second tier. Copilot CLI is an adapter slot, verified at build time (Q5).
- A2. "Restore" means: un-minimize, bring to the foreground, maximize the OS window,
  then select the tab or terminal inside it. "Maximize" means the OS maximized state
  (Windows `SW_MAXIMIZE`, macOS window zoom, EWMH maximized), not full-screen (D-09).
- A3. "Needs attention" means one of: a permission decision, a request for input, an
  error that stopped the turn, a finished turn. Exact triggers in
  `docs/contracts/attention.md`. A finished turn is attention by default and can be
  turned off.
- A4. The daemon runs as the logged-in user in the interactive desktop session. It is
  not a service and never runs elevated.
- A5. The browser is Chromium-based or Firefox, current version, on the same machine.
- A6. Woody accepts one-time OS permission prompts: macOS Accessibility and Automation;
  on GNOME Wayland, installing one shell extension for window focus.
- A7. Claude Code version >= the one that ships `PermissionRequest`, `StopFailure`,
  `Notification.notification_type` and exec-form command hooks (`args`, used by
  `claude-hooks.md` 1) (current docs at code.claude.com/docs/en/hooks,
  read 2026-11-08). Older versions degrade to Notification-only attention.
- A8. One daemon per OS user. A second `mc start` detects the first and exits 0.

## 7. Acceptance criteria

Each AC names the gate that proves it. `auto` = covered by `npm run gate`; `manual` = a
row of the per-OS manual checklist in `docs/TEST-PLAN.md` section 6.

| AC | Criterion | Proof |
|---|---|---|
| AC-01 | With the daemon running, a Claude Code `SessionStart` delivered through `mc-hook` produces a card in the open page within 1 s. | auto: `e2e/golden-path.spec.ts` GP-01 |
| AC-02 | A card shows: callsign, project, branch, host badge, state label, elapsed time since start, last event summary, restore capability light. | auto: `e2e/card.spec.ts` CARD-01 |
| AC-03 | Every Claude Code event in `docs/contracts/attention.md` table 1 moves the card to the state the table says; covered row by row. | auto: `packages/core/test/attention.test.ts` SM-01..SM-38 |
| AC-04 | Entering `needs_permission`, `needs_input`, `error` or `idle+done` sends exactly one OS notification per entry; repeats within the dedupe window send none. | auto: `packages/core/test/notify-policy.test.ts` NP-01..NP-14 |
| AC-05 | No notification is sent while the session's own window is the foreground window (when `suppressWhenFocused` is true). | auto: NP-08; manual: W-07, M-07, L-07 |
| AC-06 | RESTORE on a Windows Terminal, conhost, or VS Code integrated terminal session on Windows 11 brings the window to the foreground and maximizes it; for VS Code the session's terminal tab is the active terminal. | manual: W-01..W-04; auto (fake platform): GP-04 |
| AC-07 | RESTORE on Terminal.app and iTerm2 selects the session's tab and zooms the window, after Automation permission is granted; without it, the card shows `PERMISSION` and a fix-it hint. | manual: M-01..M-04 |
| AC-08 | RESTORE on Linux X11 (any EWMH WM) focuses and maximizes the window; on sway, Hyprland, KDE Plasma 6 the same; on GNOME Wayland with the extension the same, without it the card shows capability `none` and the reason. | manual: L-01..L-06; auto: `packages/platform/test/os/linux-x11.os.test.ts` LO-01..LO-04 on Xvfb in CI |
| AC-09 | Clicking an OS notification restores that session on Windows and Linux (X11, sway, Hyprland, KDE); on macOS when `alerter` or `terminal-notifier` is installed; otherwise the click opens the page with that card highlighted. | manual: W-05, M-05, L-05 |
| AC-10 | The daemon binds only `127.0.0.1`. A request with a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` gets 421. A state-changing request without a valid session cookie and CSRF header, or with a foreign `Origin`, gets 403. | auto: `packages/daemon/test/security.test.ts` SEC-01..SEC-15 |
| AC-11 | `mc-hook` never blocks or fails Claude Code: it exits 0 within 1500 ms with the daemon down, up, or hung, and writes nothing to stdout. Events while the daemon is down are spooled and ingested on next start. | auto: `packages/hook/test/hook.test.ts` HK-01..HK-10 |
| AC-12 | `mc-hook` forwards no `tool_input`, no environment variable outside the allowlist, and truncates prompt and message text to the limits in `docs/contracts/ingest.md`. | auto: HK-05, HK-06 |
| AC-13 | A session whose agent process exits without `SessionEnd` becomes `ended` within 10 s. | auto: `packages/daemon/test/liveness.test.ts` LV-01..LV-04 |
| AC-14 | Daemon restart keeps cards (state snapshot) and re-checks liveness. | auto: `packages/daemon/test/persistence.test.ts` PS-01..PS-03, `packages/daemon/test/integration/persistence.test.ts` PS-04..PS-05 |
| AC-15 | `mc install claude-code` adds the hook entries to the Claude Code user settings without removing or reordering existing hooks; `mc uninstall claude-code` removes exactly what it added. A backup is written first. | auto: `packages/cli/test/install-claude.test.ts` IC-01..IC-08 |
| AC-16 | The page matches `docs/DESIGN.md`: token values present in computed styles, the 8 state treatments, reduced-motion honoured, screenshot baselines stable. | auto: `e2e/design.spec.ts` DS-01..DS-10 |
| AC-17 | The page works with keyboard only: Tab reaches every RESTORE and ACK, Enter activates, focus ring visible; axe scan has zero serious violations. | auto: `e2e/a11y.spec.ts` AX-01..AX-04 |
| AC-18 | A Codex CLI turn completion delivered through its `notify` program produces a card in `idle` with attention `done`. | auto: `packages/hook/test/codex.test.ts` CX-01..CX-03 |
| AC-19 | `npm run gate` on a clean clone exits 0 and prints `GATE PASS n/n` on Windows, macOS and Linux (CI or a manual run recorded in `docs/validation/`). | auto |
| AC-20 | The daemon at idle with 20 sessions uses < 1% CPU averaged over 60 s and < 150 MB RSS. | auto: `packages/daemon/test/budget.test.ts` BG-01 (RSS); manual: CPU averaged over 60 s from Task Manager / `ps -o %cpu`, one line in `docs/validation/<os>-<date>.md` (there is no `mc doctor --budget`) |
| AC-21 | `mc doctor` reports, per OS, each permission and dependency the platform docs list (present / missing / how to fix) and exits 1 if a required one is missing. | auto: `packages/cli/test/doctor.test.ts` DR-01..DR-06 |

## 8. Open questions (also in the plan author's report)

- Q1. Pairing: the plan types a code into the page (D-05), complying with "never a token
  in a URL". Woody may waive the rule for a single-use code in the URL fragment (zero
  typing); D-05 lists the three small task edits that would follow.
- Q2. The Claude Code VS Code extension's command id for focusing its panel is not in
  public docs; T052 discovers it at build time (`docs/contracts/vscode-bridge.md` 4).
- Q3. WSL sessions on dev-pc: is WSL networking mirrored? If not, they are invisible.
- Q4. Is there a Mac available for the M-checklist? Without one, AC-07 and the macOS
  rows of AC-09 stay unproven and the release notes say so.
- Q5. Copilot CLI hook support and payloads: verify at build time; adapter slot only.
- Q6. Whether mission control should later surface as an Atlas widget (read-only
  `GET /api/state` from the Atlas page via the tailnet would break "local only";
  the safe form is Atlas running on the same machine).
