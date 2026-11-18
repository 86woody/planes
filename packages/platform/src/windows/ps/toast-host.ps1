# Long-lived WinRT toast host (windows.md 5.2). One JSON request per stdin line, one JSON
# reply per stdout line, replies matched by id. Runs under Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
# Must come before the first ReadLine: titles contain UTF-8 characters such as the middle dot.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

function Write-Reply([hashtable]$reply) {
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'show' {
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml([string]$req.xml)
        $t = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $t.Tag = [string]$req.tag
        $t.Group = [string]$req.group
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$req.aumid).Show($t)
        Write-Reply @{ id = $id; ok = $true }
      }
      'remove' {
        [Windows.UI.Notifications.ToastNotificationManager]::History.Remove([string]$req.tag, [string]$req.group, [string]$req.aumid)
        Write-Reply @{ id = $id; ok = $true }
      }
      'history' {
        $tags = New-Object System.Collections.Generic.List[string]
        foreach ($n in [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory([string]$req.aumid)) {
          $tags.Add([string]$n.Tag)
        }
        Write-Reply @{ id = $id; ok = $true; tags = [string[]]$tags.ToArray() }
      }
      default {
        Write-Reply @{ id = $id; ok = $false; error = "unknown op: $($req.op)" }
      }
    }
  } catch {
    Write-Reply @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
