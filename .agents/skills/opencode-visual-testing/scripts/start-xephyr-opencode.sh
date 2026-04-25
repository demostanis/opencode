#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="${OPENCODE_VISUAL_STATE:-$ROOT/.agents/skills/opencode-visual-testing/.state}"
TITLE="${OPENCODE_VISUAL_TITLE:-opencode visual test}"
DISPLAY_NUM="${OPENCODE_VISUAL_DISPLAY:-:47}"
PARENT_NUM="${OPENCODE_VISUAL_PARENT_DISPLAY:-:46}"
HEADLESS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless)
      HEADLESS=true
      shift
      ;;
    --display)
      DISPLAY_NUM="$2"
      shift 2
      ;;
    --parent-display)
      PARENT_NUM="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null || {
    echo "missing dependency: $1" >&2
    exit 1
  }
}

need Xephyr
need urxvt
need bun
need xdotool
need xrdb
if [[ "$HEADLESS" == true ]]; then
  need Xvfb
fi

mkdir -p "$STATE"

if [[ "$HEADLESS" == true ]]; then
  Xvfb "$PARENT_NUM" -screen 0 1280x960x24 -nolisten tcp >"$STATE/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 0.5
  export DISPLAY="$PARENT_NUM"
else
  XVFB_PID=""
fi

Xephyr "$DISPLAY_NUM" -screen 1280x960 -br -noreset >"$STATE/xephyr.log" 2>&1 &
XEPHYR_PID=$!
sleep 1

if [[ -f "$HOME/.Xresources" ]]; then
  DISPLAY="$DISPLAY_NUM" xrdb -merge "$HOME/.Xresources"
fi

DISPLAY="$DISPLAY_NUM" urxvt -title "$TITLE" -geometry 120x40 -e bash -lc "cd '$ROOT'; while true; do bun run dev --model opencode/big-pickle; echo; echo '[opencode exited; restarting in 1s, Ctrl-C again to stop wrapper]'; sleep 1; done" >"$STATE/urxvt.log" 2>&1 &
URXVT_PID=$!
sleep 0.5
WINDOW_ID="$(DISPLAY="$DISPLAY_NUM" xdotool search --class urxvt | tail -n 1)"

{
  printf 'DISPLAY=%q\n' "$DISPLAY_NUM"
  printf 'TITLE=%q\n' "$TITLE"
  printf 'ROOT=%q\n' "$ROOT"
  printf 'XEPHYR_PID=%q\n' "$XEPHYR_PID"
  printf 'URXVT_PID=%q\n' "$URXVT_PID"
  printf 'XVFB_PID=%q\n' "$XVFB_PID"
  printf 'WINDOW_ID=%q\n' "$WINDOW_ID"
} >"$STATE/env"

cat <<EOF
opencode visual test started

DISPLAY=$DISPLAY_NUM
TITLE=$TITLE
WINDOW_ID=$WINDOW_ID
state=$STATE/env

Use this display for input:
  DISPLAY=$DISPLAY_NUM xdotool windowfocus --sync $WINDOW_ID
  DISPLAY=$DISPLAY_NUM xdotool type --delay 1 "execute sleep 2"
  DISPLAY=$DISPLAY_NUM xdotool key Return

Use this display for screenshots:
  DISPLAY=$DISPLAY_NUM import -window root /tmp/opencode-visual-test.png

Restart opencode after edits:
  .agents/skills/opencode-visual-testing/scripts/restart-opencode.sh

Kill the visual test session:
  .agents/skills/opencode-visual-testing/scripts/kill-xephyr-opencode.sh
EOF
