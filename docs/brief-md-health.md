> Bu, global `~/.claude/CLAUDE.md`'deki Brief.md Health kuralının sürümlenmiş referans kopyasıdır (GEL-6). Kaynak değişirse burası da güncellenmeli.

## Brief.md Health

Maximum healthy size: 3000 lines.
Orchestrator checks this at the start of every invocation and auto-rotates
if exceeded (see scripts/rotate-brief.ps1). A .bak copy is written before
any live rotation because context/ is often not git-tracked.

Archived phases live in context/archive/, indexed in context/archive/INDEX.md.
The rotation regex assumes '## Orchestrator Output — ...' phase headers;
verify with -DryRun before first live use in any project whose brief uses
a different header format.
