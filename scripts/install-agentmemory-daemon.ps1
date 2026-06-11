# Registers (or re-registers) the AgentMemoryDaemon scheduled task that runs
# agentmemory-watchdog.ps1 at logon. Idempotent — safe to re-run after editing
# the watchdog or moving the repo.
#
# Limitations (deliberate):
# - Logon trigger only. -AtStartup requires elevation and is useless anyway in
#   "run only when logged on" mode (Logon Mode: Interactive only).
# - The watchdog (and therefore the worker) dies at logoff and returns at the
#   next logon.

$ErrorActionPreference = "Stop"

$WatchdogScript = Join-Path $PSScriptRoot "agentmemory-watchdog.ps1"
$RepoRoot       = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $WatchdogScript)) { throw "watchdog script not found: $WatchdogScript" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`"" `
    -WorkingDirectory $RepoRoot
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Self-heal for the watchdog itself: a time-based trigger that re-fires every
# 5 minutes, active from registration (a logon trigger's repetition only arms
# at the NEXT logon — verified: it never ticked in the current session).
# With -MultipleInstances IgnoreNew the tick is swallowed while the watchdog
# lives; if the watchdog process dies, the next tick relaunches it (<=5 min gap).
# 10 years ~ indefinite; [TimeSpan]::MaxValue renders as invalid task XML.
$tickTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$trigger = @($logonTrigger, $tickTrigger)

Register-ScheduledTask -TaskName "AgentMemoryDaemon" `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Limited -Force | Out-Null

Write-Host "AgentMemoryDaemon registered -> $WatchdogScript"
Write-Host "Start now with: Start-ScheduledTask -TaskName AgentMemoryDaemon"
