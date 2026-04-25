#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="${OPENCODE_VISUAL_STATE:-$ROOT/.agents/skills/opencode-visual-testing/.state}"

if [[ ! -f "$STATE/env" ]]; then
  echo "missing state file: $STATE/env" >&2
  exit 1
fi

source "$STATE/env"

for pid in "${URXVT_PID:-}" "${XEPHYR_PID:-}" "${XVFB_PID:-}"; do
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
  fi
done

rm -f "$STATE/env"

echo "killed opencode visual test session"
