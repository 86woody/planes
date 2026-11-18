# T041 (windows.md 4): list the TabItem controls of a window as JSON.
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File wt-tabs.ps1 <hwnd-decimal>
# Output: [{"index":0,"name":"...","selected":true}]
param([Parameter(Mandatory = $true)][string]$Hwnd)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$Hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$out = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $items.Count; $i++) {
  $el = $items.Item($i)
  $pat = $null
  $selected = $false
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
    $selected = [bool]$pat.Current.IsSelected
  }
  [void]$out.Add([pscustomobject]@{ index = $i; name = [string]$el.Current.Name; selected = $selected })
}
Write-Output (ConvertTo-Json -InputObject @($out.ToArray()) -Compress)
