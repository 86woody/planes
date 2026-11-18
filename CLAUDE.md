@AGENTS.md

# Claude-specific

- Builders run as Haiku with their task file as the prompt; validators run as Haiku or
  Sonnet; the orchestrator runs as Opus or Sonnet. `docs/ORCHESTRATION.md` section 4
  says which and when to escalate.
- Subagents never launch subagents (one level of delegation).
- Use the Bash or PowerShell tool for the acceptance command exactly as written in the
  task file; paste its tail into `docs/checkpoints/T###.md`.
- Do not install Claude Code hooks into the real `~/.claude/settings.json` while
  building. The installer task tests against `MC_HOME` and a temp `CLAUDE_CONFIG_DIR`.
