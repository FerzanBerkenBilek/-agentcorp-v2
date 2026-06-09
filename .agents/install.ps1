# AgentCorp v2 — Agent Installation Script (Windows PowerShell)
# Installs 20 specialized agents + global CLAUDE.md to ~/.claude/

$ErrorActionPreference = "Stop"

$AgentsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = "$env:USERPROFILE\.claude"
$ClaudeAgentsDir = "$ClaudeDir\agents"
$ContextDir = Split-Path -Parent $AgentsDir | Join-Path -ChildPath "context"

Write-Host "AgentCorp v2 — Agent Setup" -ForegroundColor Cyan
Write-Host "==========================" -ForegroundColor Cyan

# Create directories
New-Item -ItemType Directory -Force -Path $ClaudeAgentsDir | Out-Null

# Copy agent files
Write-Host "Installing 20 agents to $ClaudeAgentsDir..."
Get-ChildItem "$AgentsDir\*.md" | Where-Object { $_.Name -ne "CLAUDE.md" } |
  Copy-Item -Destination $ClaudeAgentsDir -Force

# Copy global CLAUDE.md
Write-Host "Installing CLAUDE.md to $ClaudeDir..."
Copy-Item "$AgentsDir\CLAUDE.md" "$ClaudeDir\CLAUDE.md" -Force

# Create context directory and files
Write-Host "Creating context scratchpad..."
New-Item -ItemType Directory -Force -Path $ContextDir | Out-Null
if (-not (Test-Path "$ContextDir\brief.md")) {
  "# Active Brief`n_No active brief._" | Out-File "$ContextDir\brief.md" -Encoding utf8
}
if (-not (Test-Path "$ContextDir\decisions.md")) {
  "# Architecture Decisions`n_No decisions yet._" | Out-File "$ContextDir\decisions.md" -Encoding utf8
}
if (-not (Test-Path "$ContextDir\patterns.md")) {
  "# Learned Patterns`n_No patterns yet._" | Out-File "$ContextDir\patterns.md" -Encoding utf8
}

$AgentCount = (Get-ChildItem "$ClaudeAgentsDir\*.md").Count
Write-Host ""
Write-Host "Done! Installed:" -ForegroundColor Green
Write-Host "  agents: $AgentCount" -ForegroundColor Green
Write-Host "  CLAUDE.md: $ClaudeDir\CLAUDE.md" -ForegroundColor Green
Write-Host "  context/: $ContextDir" -ForegroundColor Green
Write-Host ""
Write-Host "IMPORTANT: Also install required MCP servers (see README.md)" -ForegroundColor Yellow
