#!/bin/bash
# AgentCorp v2 — Agent Installation Script
# Installs 20 specialized agents + global CLAUDE.md to ~/.claude/

set -e

AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_AGENTS_DIR="$CLAUDE_DIR/agents"
CONTEXT_DIR="$(cd "$AGENTS_DIR/.." && pwd)/context"

echo "AgentCorp v2 — Agent Setup"
echo "=========================="

# Create directories
mkdir -p "$CLAUDE_AGENTS_DIR"

# Copy agent files
echo "Installing 20 agents to $CLAUDE_AGENTS_DIR..."
cp "$AGENTS_DIR"/*.md "$CLAUDE_AGENTS_DIR/"
# Remove CLAUDE.md from agents dir (it goes to root)
rm -f "$CLAUDE_AGENTS_DIR/CLAUDE.md"

# Copy global CLAUDE.md
echo "Installing CLAUDE.md to $CLAUDE_DIR..."
cp "$AGENTS_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"

# Create context directory and files
echo "Creating context scratchpad..."
mkdir -p "$CONTEXT_DIR"
[ ! -f "$CONTEXT_DIR/brief.md" ] && \
  echo "# Active Brief\n_No active brief._" > "$CONTEXT_DIR/brief.md"
[ ! -f "$CONTEXT_DIR/decisions.md" ] && \
  echo "# Architecture Decisions\n_No decisions yet._" > "$CONTEXT_DIR/decisions.md"
[ ! -f "$CONTEXT_DIR/patterns.md" ] && \
  echo "# Learned Patterns\n_No patterns yet._" > "$CONTEXT_DIR/patterns.md"

echo ""
echo "Done! Installed:"
ls "$CLAUDE_AGENTS_DIR"/*.md | wc -l | xargs echo "  agents:"
echo "  CLAUDE.md: $CLAUDE_DIR/CLAUDE.md"
echo "  context/: $CONTEXT_DIR"
echo ""
echo "IMPORTANT: Also install required MCP servers (see README.md)"
