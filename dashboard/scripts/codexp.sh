#!/bin/bash
#
# codexp - Codex CLI wrapper with performance logging
#
# Usage:
#   1. Add to your shell config (~/.zshrc or ~/.bashrc):
#      source /path/to/ai-dashboard/scripts/codexp.sh
#
#   2. Use 'codexp' instead of 'codex':
#      codexp "your prompt here"
#
# Logs are written to ~/.ai-perf.log in the format:
#   codex,total_ms=1234,exit=0,ts=1737569201
#

AI_PERF_LOG="${AI_PERF_LOG:-$HOME/.ai-perf.log}"

codexp() {
  local t0=$(python3 -c 'import time; print(int(time.time() * 1000))')
  
  # Run codex with all arguments
  codex "$@"
  local exit_code=$?
  
  local t1=$(python3 -c 'import time; print(int(time.time() * 1000))')
  local total_ms=$((t1 - t0))
  local ts=$(date +%s)
  
  # Log the timing
  echo "codex,total_ms=${total_ms},exit=${exit_code},ts=${ts}" >> "$AI_PERF_LOG"
  
  return $exit_code
}

# Also create an alias for convenience
alias cx='codexp'

echo "[codexp] Wrapper loaded. Use 'codexp' or 'cx' instead of 'codex'."
echo "[codexp] Logs will be written to: $AI_PERF_LOG"
