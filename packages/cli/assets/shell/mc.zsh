# mission-control shell integration (zsh). Source it from ~/.zshrc (the installer adds the line).
# Reports ShellStart, ShellCommandStart, ShellCommandEnd, ShellPrompt and ShellExit to mc-hook.
# Does nothing unless the env file names an existing MC_HOOK_JS. The installer replaces
# __MC_STATE_DIR__ with <stateDir>; MC_SHELL_ENV overrides the path (tests).
# Only the first word of a command is sent. Hook calls are backgrounded and silent.

__mc_env_file="${MC_SHELL_ENV:-__MC_STATE_DIR__/shell.env}"
__mc_node=""
__mc_hook=""
__mc_otel=""
if [[ -r "$__mc_env_file" ]]; then
  while IFS= read -r __mc_line || [[ -n "$__mc_line" ]]; do
    case "$__mc_line" in
      MC_NODE=*) __mc_node="${__mc_line#MC_NODE=}" ;;
      MC_HOOK_JS=*) __mc_hook="${__mc_line#MC_HOOK_JS=}" ;;
      MC_OTEL_DIR=*) __mc_otel="${__mc_line#MC_OTEL_DIR=}" ;;
    esac
  done < "$__mc_env_file"
fi
unset __mc_line __mc_env_file

# Copilot OTel file exporter, one file per shell (D-56 item 6). A value the user set is kept.
if [[ -n "$__mc_otel" && -z "${COPILOT_OTEL_FILE_EXPORTER_PATH:-}" ]]; then
  if mkdir -p "$__mc_otel" 2>/dev/null; then
    export COPILOT_OTEL_FILE_EXPORTER_PATH="$__mc_otel/shell-$$.jsonl"
  fi
fi
unset __mc_otel

if [[ -n "$__mc_node" && -n "$__mc_hook" && -f "$__mc_hook" && -z "${__MC_LOADED:-}" ]]; then
  typeset -g __MC_LOADED=1
  typeset -g __mc_running=0
  typeset -g __mc_word=""
  typeset -g __mc_t0=0
  zmodload zsh/datetime 2>/dev/null
  autoload -Uz add-zsh-hook

  __mc_send() {
    ( "$__mc_node" "$__mc_hook" shell "$@" >/dev/null 2>&1 & )
  }

  __mc_preexec() {
    __mc_word="${1%% *}"
    __mc_running=1
    __mc_t0=$EPOCHREALTIME
    __mc_send ShellCommandStart --command "$__mc_word"
  }

  __mc_precmd() {
    local rc=$?
    if (( __mc_running )); then
      __mc_running=0
      local -i ms=$(( (EPOCHREALTIME - __mc_t0) * 1000 ))
      __mc_send ShellCommandEnd --exit "$rc" --duration-ms "$ms" --command "$__mc_word"
    fi
    __mc_send ShellPrompt
    return $rc
  }

  add-zsh-hook preexec __mc_preexec
  add-zsh-hook precmd __mc_precmd
  trap '__mc_send ShellExit' EXIT
  __mc_send ShellStart
fi
