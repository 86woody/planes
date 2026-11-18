# mission-control shell integration (PowerShell 7). Dot-source it from $PROFILE (the installer
# adds the line). Reports ShellStart, ShellCommandStart, ShellCommandEnd, ShellPrompt and
# ShellExit to mc-hook. Does nothing unless the env file names an existing MC_HOOK_JS.
# The installer replaces __MC_STATE_DIR__ with <stateDir>; $env:MC_SHELL_ENV overrides it (tests).
# Only the first word of a command is sent. Hook processes are started, never waited on.

if ($global:__mcLoaded) { return }

$global:__mcEnvFile = if ($env:MC_SHELL_ENV) { $env:MC_SHELL_ENV } else { '__MC_STATE_DIR__\shell.env' }
$global:__mcNode = ''
$global:__mcHook = ''
$global:__mcOtelDir = ''
if (Test-Path -LiteralPath $global:__mcEnvFile -PathType Leaf) {
  foreach ($line in [System.IO.File]::ReadAllLines($global:__mcEnvFile)) {
    if ($line.StartsWith('MC_NODE=')) { $global:__mcNode = $line.Substring(8) }
    elseif ($line.StartsWith('MC_HOOK_JS=')) { $global:__mcHook = $line.Substring(11) }
    elseif ($line.StartsWith('MC_OTEL_DIR=')) { $global:__mcOtelDir = $line.Substring(12) }
  }
}
# Copilot OTel file exporter, one file per shell (D-56 item 6). A value the user set is kept.
if ($global:__mcOtelDir -and -not $env:COPILOT_OTEL_FILE_EXPORTER_PATH) {
  try {
    New-Item -ItemType Directory -Force -Path $global:__mcOtelDir | Out-Null
    $env:COPILOT_OTEL_FILE_EXPORTER_PATH = "$global:__mcOtelDir/shell-$PID.jsonl"
  } catch {
    # The exporter path is optional: a failure here must not break the prompt.
  }
}
if (-not $global:__mcNode -or -not $global:__mcHook -or -not (Test-Path -LiteralPath $global:__mcHook -PathType Leaf)) {
  return
}

$global:__mcLoaded = $true
$global:__mcRunning = $false
$global:__mcWord = ''
$global:__mcSw = [System.Diagnostics.Stopwatch]::new()

function global:__mc_send {
  param([string[]]$Parts)
  try {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $global:__mcNode
    $psi.ArgumentList.Add($global:__mcHook)
    $psi.ArgumentList.Add('shell')
    foreach ($p in $Parts) { $psi.ArgumentList.Add($p) }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [void][System.Diagnostics.Process]::Start($psi)
  } catch {
    # Telemetry must never break the prompt.
  }
}

function global:__mc_cmd_start {
  param([string]$Line)
  if (-not $Line) { return }
  $word = ($Line.Trim() -split '\s+', 2)[0]
  if (-not $word) { return }
  $global:__mcWord = $word
  $global:__mcRunning = $true
  $global:__mcSw.Restart()
  __mc_send @('ShellCommandStart', '--command', $word)
}

$global:__mcPrev = $function:prompt

function global:prompt {
  $code = if ($?) { 0 } else { 1 }
  if ($global:__mcRunning) {
    $global:__mcRunning = $false
    $global:__mcSw.Stop()
    $ms = [int]$global:__mcSw.ElapsedMilliseconds
    __mc_send @('ShellCommandEnd', '--exit', "$code", '--duration-ms', "$ms", '--command', $global:__mcWord)
  }
  __mc_send @('ShellPrompt')
  if ($global:__mcPrev) { & $global:__mcPrev } else { "PS $($PWD.Path)> " }
}

try {
  if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
      $line = $null
      $cursor = $null
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      __mc_cmd_start $line
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  }
} catch {
  # No PSReadLine (non-interactive host): command events are skipped, prompt events still work.
}

Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { __mc_send @('ShellExit') } | Out-Null
__mc_send @('ShellStart')
