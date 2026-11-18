# T041 (windows.md 4): select the TabItem at <index> of a window.
# T109 (D-54): skip Select() when that tab is already selected, and afterwards give keyboard
# focus to the visible terminal control, so typing reaches the agent (Select() alone leaves
# focus on the tab strip).
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File wt-select-tab.ps1 <hwnd-decimal> <index>
# Output: {"ok":true}
param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][int]$Index
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$Hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($Index -lt 0 -or $Index -ge $items.Count) { throw "tab index $Index out of range ($($items.Count) tabs)" }
$pat = $items.Item($Index).GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
if (-not $pat.Current.IsSelected) {
  $pat.Select()
  Start-Sleep -Milliseconds 150
}
# Keyboard focus to the terminal of the selected tab: the TermControl that is on screen.
$termCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
$terms = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $termCond)
for ($i = 0; $i -lt $terms.Count; $i++) {
  $t = $terms.Item($i)
  if (-not $t.Current.IsOffscreen) {
    try { $t.SetFocus() } catch { }
    break
  }
}
Write-Output '{"ok":true}'
