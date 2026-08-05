<#
.SYNOPSIS
  Registers (or updates) a Windows Scheduled Task that scrapes the configured mobile.de search
  a few times a day.

.DESCRIPTION
  IMPORTANT: the scraper drives a real, visible Chrome window — that is what gets past
  mobile.de's bot detection (a headless or Playwright-launched browser is blocked). A visible
  window needs an interactive desktop session, so the task is registered to run ONLY while you
  are logged on. It will not run on the lock screen with the session signed out.

  The window is positioned offscreen (config.json -> browser.offscreen), so in practice you
  will not see it. Set offscreen to false if you want to watch it work.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Times 07:30,13:00,19:30
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister
#>
param(
  [string]$TaskName = "mobile.de tracker",
  [string[]]$Times = @("08:00", "14:00", "20:00"),
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root "scripts\run-scrape.cmd"

if (-not (Test-Path $cmd)) { throw "Missing $cmd" }

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "Removed scheduled task '$TaskName'."
  } else {
    "No scheduled task named '$TaskName'."
  }
  return
}

$action = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $root

$triggers = foreach ($t in $Times) { New-ScheduledTaskTrigger -Daily -At $t }

# StartWhenAvailable catches up after the machine was asleep/off at the scheduled time.
# IgnoreNew means a slow run is never overlapped by the next trigger (the scraper also
# takes a lock file, so this is belt-and-braces).
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries

# Interactive: required because Chrome must have a desktop to open a window on.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Description "Snapshots a mobile.de search and records price/listing history." | Out-Null

"Registered '$TaskName' to run at: $($Times -join ', ')"
""
"Runs as        $env:USERDOMAIN\$env:USERNAME (only while logged on)"
"Command        $cmd"
"Log            $(Join-Path $root 'data\scrape.log')"
""
"Note: config.json politeness.minMinutesBetweenRuns (currently the guard) makes the scraper"
"skip a trigger that fires too soon after a successful run, so extra triggers are harmless."
""
"Run it now:     Start-ScheduledTask -TaskName '$TaskName'"
"Check history:  Get-ScheduledTaskInfo -TaskName '$TaskName'"
"Remove:         powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister"
