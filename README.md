# Mission Control

A local control plane for every agent and terminal session on this machine, styled as
a rocket-launch mission control room. Open `http://127.0.0.1:47800/` and each session
is a console card: what it is doing, whether it needs you, and a **RESTORE** button
that brings its window forward and maximizes it, wherever it lives (VS Code, Windows
Terminal, conhost, Terminal.app, iTerm2, a Linux terminal). When a session needs
attention (a permission prompt, waiting for input, a finished turn, an error), the OS
raises a notification; clicking it restores that session where the OS allows.

Windows 11, macOS 13+ and Linux (X11 and the Wayland compositors listed in
`docs/platforms/linux.md`). Nothing leaves the machine: the daemon binds `127.0.0.1`.

**Status: planning.** Specs only. No source code exists yet. The build is broken into
Haiku-sized tasks in `docs/TASKS.md` and run by the protocol in `docs/ORCHESTRATION.md`.

## Map of the docs

| Doc | What it answers |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | How to work on this repo: branches, gates, the task protocol |
| `docs/PRD.md` | Goals, non-goals, assumptions, numbered acceptance criteria (AC-nn) |
| `docs/ARCHITECTURE.md` | Components, process model, data flow, security model |
| `docs/contracts/` | **Frozen** interfaces builders code against (schemas, API, protocols) |
| `docs/platforms/windows.md`, `macos.md`, `linux.md` | Exact OS APIs, permissions, failure modes, degraded behaviour |
| `docs/DESIGN.md` | The mission-control visual language: tokens, card anatomy, states, motion |
| `docs/TEST-PLAN.md` | Unit, integration, e2e (Playwright), per-OS manual checks, CI matrix, the project gate |
| `docs/TASKS.md` and `docs/tasks/T###.md` | The build as tasks, milestones and waves |
| `docs/ORCHESTRATION.md` | How an orchestrator runs Haiku builders: waves, branches, merges, failure, escalation |
| `docs/DECISIONS.md` | Decision log (D-nn) with alternatives considered |
| `docs/review/` | Adversarial review rounds and responses |

## The one command (once built)

```
npm run gate
```

Exit 0 and a last line `GATE m5 PASS <n>/<n>` means the product works on this OS. Its
stages are defined in `docs/TEST-PLAN.md` section 2.
