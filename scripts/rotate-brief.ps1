param(
    [int]$KeepLast = 2,
    [switch]$DryRun,
    [string]$Path = "context"
)

$briefPath = Join-Path $Path "brief.md"
$archiveDir = Join-Path $Path "archive"
$indexPath = Join-Path $archiveDir "INDEX.md"

if (-not (Test-Path $briefPath)) {
    Write-Error "brief.md not found at $briefPath"
    exit 1
}

if (-not (Test-Path $archiveDir)) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
}

if (-not (Test-Path $indexPath)) {
    "# Archive Index`n`n| Phase | Date | File | Summary |`n|-------|------|------|---------|" |
        Out-File -FilePath $indexPath -Encoding utf8
}

$lines = Get-Content $briefPath -Encoding UTF8

$phasePattern = '^##\s+Orchestrator Output\s+—\s+(.+?)\s+—\s+(.+)$'
$phaseBoundaries = @()

for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $phasePattern) {
        $phaseBoundaries += [PSCustomObject]@{
            LineIndex = $i
            Name      = $matches[1]
            Date      = $matches[2]
        }
    }
}

if ($phaseBoundaries.Count -le $KeepLast) {
    Write-Host "Only $($phaseBoundaries.Count) phase(s) found — nothing to archive (keeping last $KeepLast)."
    exit 0
}

$toArchive = $phaseBoundaries[0..($phaseBoundaries.Count - $KeepLast - 1)]
$toKeep = $phaseBoundaries[($phaseBoundaries.Count - $KeepLast)..($phaseBoundaries.Count - 1)]

Write-Host "Found $($phaseBoundaries.Count) phases. Archiving $($toArchive.Count), keeping $($toKeep.Count)."

for ($j = 0; $j -lt $toArchive.Count; $j++) {
    $phase = $toArchive[$j]
    $startLine = $phase.LineIndex
    $endLine = if ($j + 1 -lt $toArchive.Count) {
        $toArchive[$j + 1].LineIndex - 1
    } else {
        $toKeep[0].LineIndex - 1
    }

    $phaseContent = $lines[$startLine..$endLine] -join "`n"
    $slug = ($phase.Name -replace '[^a-zA-Z0-9\-]', '-' -replace '-+', '-').ToLower().Trim('-')
    $dateSlug = (Get-Date).ToString("yyyy-MM-dd")
    $archiveFile = Join-Path $archiveDir "phase-$slug-$dateSlug.md"

    if ($DryRun) {
        Write-Host "[DRY RUN] Would archive: $($phase.Name) -> $archiveFile ($(($endLine - $startLine + 1)) lines)"
    } else {
        $phaseContent | Out-File -FilePath $archiveFile -Encoding utf8
        Write-Host "Archived: $($phase.Name) -> $archiveFile ($(($endLine - $startLine + 1)) lines)"
        $summaryLine = "| $($phase.Name) | $($phase.Date) | $archiveFile | Phase completed and archived |"
        Add-Content -Path $indexPath -Value $summaryLine
    }
}

if (-not $DryRun) {
    # ── PREAMBLE'I OLDUĞU GİBİ KORU ──
    # İlk arşivlenen fazdan ÖNCEKİ her şey (başlık, Hierarchy Execution Log
    # tablosu, navigasyon, kalıcı notlar) AYNEN korunur. '^<!--' filtresi
    # YOK — o filtre yorum-olmayan tablo/timeline satırlarını yok ederdi.
    $preambleEnd = $toArchive[0].LineIndex - 1
    $preambleLines = if ($preambleEnd -ge 0) { $lines[0..$preambleEnd] } else { @() }

    $archiveNote = @"

## Archived Phases

$($toArchive.Count) earlier phase(s) archived to context/archive/.
See context/archive/INDEX.md for the full list and summaries.

---

"@
    $keepStartLine = $toKeep[0].LineIndex
    $keptContent = $lines[$keepStartLine..($lines.Count - 1)] -join "`n"

    $finalContent = (($preambleLines -join "`n") + $archiveNote + $keptContent)
    $finalContent | Out-File -FilePath $briefPath -Encoding utf8

    # ── KAYIP-YOK SAĞLAMA (satır muhasebesi) ──
    $archivedCount = 0
    Get-ChildItem $archiveDir -Filter "phase-*-$dateSlug.md" | ForEach-Object {
        $archivedCount += (Get-Content $_.FullName).Count
    }
    $newBrief = (Get-Content $briefPath).Count
    Write-Host ""
    Write-Host "brief.md rotated: $($lines.Count) -> $newBrief lines"
    Write-Host "Accounting: preamble $($preambleLines.Count) + kept block + archived $archivedCount (note lines eklendi)"
}
