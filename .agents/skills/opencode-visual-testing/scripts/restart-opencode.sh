#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="${OPENCODE_VISUAL_STATE:-$ROOT/.agents/skills/opencode-visual-testing/.state}"

if [[ ! -f "$STATE/env" ]]; then
  echo "missing state file: $STATE/env" >&2
  echo "start the visual test display first:" >&2
  echo "  .agents/skills/opencode-visual-testing/scripts/start-xephyr-opencode.sh --headless" >&2
  exit 1
fi

source "$STATE/env"

command -v xdotool >/dev/null || {
  echo "missing dependency: xdotool" >&2
  exit 1
}

WINDOW="${WINDOW_ID:-}"
if [[ -z "$WINDOW" ]]; then
  WINDOW="$(DISPLAY="$DISPLAY" xdotool search --class urxvt | tail -n 1)"
fi
if [[ -z "$WINDOW" ]]; then
  echo "could not find urxvt window on DISPLAY=$DISPLAY" >&2
  exit 1
fi

DISPLAY="$DISPLAY" xdotool windowfocus --sync "$WINDOW"
DISPLAY="$DISPLAY" xdotool key ctrl+c

echo "sent Ctrl-C to $TITLE on DISPLAY=$DISPLAY"
echo "the wrapper relaunches: bun run dev --model opencode/big-pickle"
