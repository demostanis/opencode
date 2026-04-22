#!/bin/bash
# Script to reproduce the scrollbar hover scroll bug in the TUI
# Uses Xephyr for isolation

set -e

TIMESTAMP=$(date +%s)
LOGFILE="/tmp/scrollbar-bug-${TIMESTAMP}.log"
RECORDFILE="/tmp/scrollbar-session-${TIMESTAMP}.log"

echo "=== Scrollbar Hover Scroll Bug Reproduction ==="
echo "Log: $LOGFILE"
echo "Session record: $RECORDFILE"
echo ""

log() {
    echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"
}

# Kill any existing Xephyr instances
pkill -f Xephyr 2>/dev/null || true
sleep 1

# Start Xephyr display
log "Starting Xephyr display..."
Xephyr :99 -screen 120x40 &
XEPHYR_PID=$!
log "Xephyr PID: $XEPHYR_PID"

sleep 2

# Set DISPLAY
export DISPLAY=:99

# Start the TUI
log "Starting opencode TUI..."
cd /run/archiso/data/programming/opencode

# Start a new opencode session in a way we can interact with
urxvt -geometry 120x40 +sb -e bash -c "DISPLAY=:99 bun run dev" &
TUI_PID=$!
log "TUI PID: $TUI_PID"

sleep 5

# Get the urxvt window ID
URXVT_WID=$(xdotool search --name "urxvt" 2>/dev/null | head -1 || echo "")
if [ -z "$URXVT_WID" ]; then
    log "ERROR: Could not find urxvt window"
    kill $XEPHYR_PID 2>/dev/null || true
    kill $TUI_PID 2>/dev/null || true
    exit 1
fi

log "urxvt window ID: $URXVT_WID"

# Focus the window
xdotool windowfocus "$URXVT_WID"
sleep 1

# Get window geometry
eval "$(xdotool getwindowgeometry --shell "$URXVT_WID")"
log "Window at: $X,$Y (${WIDTH}x${HEIGHT})"

# Type to create scrollable content
log "Typing content to create scrollable conversation..."
for i in {1..20}; do
    xdotool type "Paragraph $i: Lorem ipsum dolor sit amet, consectetur adipiscing elit. "
    xdotool key Return
    sleep 0.2
done

log "Content typed. Waiting for TUI to render..."
sleep 3

# Move mouse to the scrollbar area (right side of window)
SCROLLBAR_X=$((X + WIDTH - 10))
SCROLLBAR_Y=$((Y + HEIGHT / 2))

log "Initial scrollbar position: ($SCROLLBAR_X, $SCROLLBAR_Y)"

# Take initial screenshot
import -window "$URXVT_WID" "/tmp/scrollbar-before-${TIMESTAMP}.png" 2>/dev/null || true

# Move mouse to scrollbar and hover for 2 seconds
log "Moving mouse to scrollbar and hovering for 2 seconds..."
xdotool mousemove $SCROLLBAR_X $SCROLLBAR_Y
sleep 2

# Take screenshot after hovering
import -window "$URXVT_WID" "/tmp/scrollbar-after-${TIMESTAMP}.png" 2>/dev/null || true

# Move mouse away
xdotool mousemove $((X + 100)) $((Y + 100))
sleep 1

log "Test complete!"

# Cleanup
kill $TUI_PID 2>/dev/null || true
kill $XEPHYR_PID 2>/dev/null || true

echo ""
echo "=== Test Complete ==="
echo "Log file: $LOGFILE"
echo "Before screenshot: /tmp/scrollbar-before-${TIMESTAMP}.png"
echo "After screenshot: /tmp/scrollbar-after-${TIMESTAMP}.png"
echo ""
echo "If the conversation scrolled while hovering (without clicking),"
echo "the bug is confirmed."
