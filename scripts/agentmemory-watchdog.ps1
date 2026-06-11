# agentmemory watchdog — keeps the worker alive across session boundaries.
# The iii.exe engine detaches and survives, but the agentmemory worker runs
# in the foreground of whatever shell launched it (cli.mjs `await import(worker)`),
# so it dies with that shell. This loop owns the worker as its own child instead.
#
# Installed as the "AgentMemoryDaemon" scheduled task by
# scripts\install-agentmemory-daemon.ps1 (run that after editing this file).
#
# Health probe is /agentmemory/livez — the endpoint the CLI itself uses.
# (/agentmemory/health does NOT exist; it returns 404 even when healthy.)
# A 404 means the engine is up but the worker is dead — exactly the state
# this watchdog exists to repair — and Invoke-WebRequest throws on 404, so
# the catch branch handles both "port dead" and "worker dead".

$AgentMemoryCmd = "$env:APPDATA\npm\agentmemory.cmd"
$LogDir         = "$env:USERPROFILE\scripts"
$LogFile        = Join-Path $LogDir "agentmemory-watchdog.log"
$HealthUrl      = "http://localhost:3111/agentmemory/livez"

# The engine stores observations in a CWD-relative ./data/state_store.db.
# The existing corpus lives in agentcorp-v2\data, so the worker MUST be
# started from there — a scheduled task's default CWD is System32, where
# the engine cannot create ./data and the KV dies with 503s.
$WorkDir        = Split-Path -Parent $PSScriptRoot
Set-Location $WorkDir
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

# Logging must never be able to kill the loop (locked file, full disk, ...).
function Write-Log($msg) {
    try {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8
    } catch {}
}

Write-Log "watchdog started (pid $PID, workdir $WorkDir)"

while ($true) {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        # healthy, wait
    } catch {
        Write-Log "agentmemory down ($($_.Exception.Message.Trim())), restarting..."
        try {
            # Worker stays a child of this watchdog, so it lives as long as the
            # logon session. CI=1 keeps any interactive prompt paths quiet.
            $env:CI = "1"
            Start-Process -FilePath $AgentMemoryCmd `
                -WorkingDirectory $WorkDir `
                -NoNewWindow `
                -RedirectStandardOutput (Join-Path $LogDir "agentmemory-worker.out.log") `
                -RedirectStandardError  (Join-Path $LogDir "agentmemory-worker.err.log")
            Write-Log "start issued via $AgentMemoryCmd"
        } catch {
            Write-Log "FAILED to start: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 5
    }
    Start-Sleep -Seconds 30
}
