# check-slop.ps1
# Runs AI slop pattern detection on src/ directory
# Usage: .\scripts\check-slop.ps1
# Usage: .\scripts\check-slop.ps1 -Path src/auth
# Usage: .\scripts\check-slop.ps1 -Strict   (P3 notlarini da goster)

param(
    [string]$Path = "src",
    [switch]$Strict
)

# PS 5.1: Join-Path yalniz 2 argüman alir
$srcDir = Join-Path (Join-Path $PSScriptRoot "..") $Path
$script:findings = @()

function Check-Pattern {
    param($Pattern, $Description, $Severity, $Files)
    foreach ($file in $Files) {
        $hits = Select-String -Path $file.FullName -Pattern $Pattern -AllMatches
        foreach ($hit in $hits) {
            $trimmed = $hit.Line.Trim()
            # script scope: fonksiyon icinden dis diziye yazmak icin $script: sart
            $script:findings += [PSCustomObject]@{
                Severity = $Severity
                File     = ($file.FullName -split [regex]::Escape("src\"))[-1]
                Line     = $hit.LineNumber
                Pattern  = $Description
                Content  = $trimmed.Substring(0, [Math]::Min(80, $trimmed.Length))
            }
        }
    }
}

$tsFiles = Get-ChildItem $srcDir -Recurse -Filter "*.ts" |
    Where-Object { $_.Name -notmatch "\.test\." -and
                   $_.Name -notmatch "\.d\.ts$" }

# P1: Empty catch blocks
Check-Pattern 'catch\s*\([^)]*\)\s*\{\s*\}' 'Empty catch block' 'P1' $tsFiles

# P1: console.log in production code
Check-Pattern 'console\.(log|warn|error|debug)\(' 'console.log in production code' 'P1' $tsFiles

# P1: any type assertion
Check-Pattern 'as\s+any\b|:\s*any\b' 'TypeScript any type' 'P1' $tsFiles

# P2: TODO/FIXME without owner
Check-Pattern '//\s*(TODO|FIXME|HACK|XXX)(?!.*@)' 'TODO/FIXME without owner (@name)' 'P2' $tsFiles

# P2: Obvious comments
Check-Pattern '//\s*(increment|decrement|return|get|set|check|create|update|delete)\s+the' 'Obvious comment (describes what, not why)' 'P2' $tsFiles

# P2: Async function with no await (line-based heuristic)
Check-Pattern 'async\s+function[^{]+\{[^}]*return\s+[^P][^r][^o]' 'Possible async function without await' 'P2' $tsFiles

# P3: Magic numbers (>300; HTTP status'lar dahil yakalanir — manuel ele)
Check-Pattern '(?<![0-9])[3-9][0-9]{2,}(?![0-9])' 'Possible magic number (>300)' 'P3' $tsFiles

$p1 = @($script:findings | Where-Object { $_.Severity -eq 'P1' })
$p2 = @($script:findings | Where-Object { $_.Severity -eq 'P2' })
$p3 = @($script:findings | Where-Object { $_.Severity -eq 'P3' })

Write-Host ""
Write-Host "=== SLOP DETECTION REPORT ===" -ForegroundColor Cyan
Write-Host "Scanned: $($tsFiles.Count) TypeScript files (path: $Path)"
Write-Host ""

if ($p1.Count -gt 0) {
    Write-Host "P1 FINDINGS ($($p1.Count)):" -ForegroundColor Red
    $p1 | Format-Table Severity, File, Line, Pattern, Content -AutoSize -Wrap
}

if ($p2.Count -gt 0) {
    Write-Host "P2 FINDINGS ($($p2.Count)):" -ForegroundColor Yellow
    $p2 | Format-Table Severity, File, Line, Pattern -AutoSize
}

if ($p3.Count -gt 0 -and $Strict) {
    Write-Host "P3 NOTES ($($p3.Count)):" -ForegroundColor Gray
    $p3 | Format-Table Severity, File, Line, Pattern -AutoSize
}

Write-Host ""
if ($p1.Count -eq 0 -and $p2.Count -eq 0) {
    Write-Host "✅ CLEAN — no P1 or P2 findings" -ForegroundColor Green
} elseif ($p1.Count -eq 0) {
    Write-Host "⚠️ WARN — $($p2.Count) P2 findings (ship allowed)" -ForegroundColor Yellow
} else {
    Write-Host "❌ FAIL — $($p1.Count) P1 findings (ship blocked)" -ForegroundColor Red
    exit 1
}
