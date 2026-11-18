# mission-control shell integration (bash). Source it from ~/.bashrc (the installer adds the line).
# Reports ShellStart, ShellCommandStart, ShellCommandEnd, ShellPrompt and ShellExit to mc-hook.
# Does nothing unless the env file names an existing MC_HOOK_JS. The installer replaces
# __MC_STATE_DIR__ with <stateDir>; MC_SHELL_ENV overrides the path (tests).
# Only the first word of a command is sent. Hook calls are backgrounded and silent.

__mc_env_file="${MC_SHELL_ENV:-__MC_STATE_DIR__/shell.env}"
__mc_node=""
__mc_hook=""
__mc_otel=""
if [ -r "$__mc_env_file" ]; then
  while IFS= read -r __mc_line || [ -n "$__mc_line" ]; do
    case "$__mc_line" in
      MC_NODE=*) __mc_node="${__mc_line#MC_NODE=}" ;;
      MC_HOOK_JS=*) __mc_hook="${__mc_line#MC_HOOK_JS=}" ;;
      MC_OTEL_DIR=*) __mc_otel="${__mc_line#MC_OTEL_DIR=}" ;;
    esac
  done < "$__mc_env_file"
  unset __mc_line
fi
unset __mc_env_file

# Copilot OTel file exporter, one file per shell (D-56 item 6). A value the user set is kept.
if [ -n "$__mc_otel" ] && [ -z "${COPILOT_OTEL_FILE_EXPORTER_PATH:-}" ]; then
  if mkdir -p "$__mc_otel" 2>/dev/null; then
    export COPILOT_OTEL_FILE_EXPORTER_PATH="$__mc_otel/shell-$$.jsonl"
  fi
fi
unset __mc_otel

if [ -n "$__mc_node" ] && [ -n "$__mc_hook" ] && [ -f "$__mc_hook" ] && [ -z "${__MC_LOADED:-}" ]; then
  __MC_LOADED=1
  __mc_armed=0
  __mc_running=0
  __mc_word=""
  __mc_t0=0
  __mc_ms=0

  __mc_send() {
    ( "$__mc_node" "$__mc_hook" shell "$@" >/dev/null 2>&1 & )
  }

  __mc_now() {
    local t="${EPOCHREALTIME:-0.000000}"
    t="${t/[.,]/}"
    __mc_ms=$(( 10#$t / 1000 ))
  }

  # DEBUG trap: fires before each top-level simple command. Only the first one after a
  # prompt is the command the user typed; the rest are ignored until the next prompt.
  __mc_debug() {
    [ "$__mc_armed" = 1 ] || return 0
    case "$BASH_COMMAND" in __mc_*) return 0 ;; esac
    __mc_armed=0
    __mc_running=1
    __mc_word="${BASH_COMMAND%% *}"
    __mc_now
    __mc_t0=$__mc_ms
    __mc_send ShellCommandStart --command "$__mc_word"
  }

  # PROMPT_COMMAND: report the end of the previous command, then the prompt.
  __mc_prompt() {
    local rc=$?
    if [ "$__mc_running" = 1 ]; then
      __mc_running=0
      __mc_now
      __mc_send ShellCommandEnd --exit "$rc" --duration-ms "$(( __mc_ms - __mc_t0 ))" --command "$__mc_word"
    fi
    __mc_send ShellPrompt
    __mc_armed=1
    return "$rc"
  }

  trap '__mc_debug' DEBUG
  PROMPT_COMMAND="__mc_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  trap '__mc_send ShellExit' EXIT
  __mc_send ShellStart
fi
