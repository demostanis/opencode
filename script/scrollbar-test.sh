#!/bin/bash
# Script to reproduce and verify the scrollbar hover scroll bug fix in TUI
# Uses Xephyr for isolation

set -e

TIMESTAMP=$(date +%s)
LOGFILE="/tmp/scrollbar-test-${TIMESTAMP}.log"

echo "=== Scrollbar Hover Scroll Bug Test ==="
echo "Log: $LOGFILE"
echo ""

log() {
    echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"
}

# Kill any existing processes
pkill -f Xephyr 2>/dev/null || true
pkill -f urxvt 2>/dev/null || true
sleep 1

# Start Xephyr display
log "Starting Xephyr display on :99..."
Xephyr :99 -screen 120x40 -screen 120x40 &
XEPHYR_PID=$!
sleep 2

# Set DISPLAY
export DISPLAY=:99

# Start the TUI
log "Starting opencode dev server..."
cd /run/archiso/data/programming/opencode

# Run the dev server in background
bun run dev > /tmp/opencode-dev-${TIMESTAMP}.log 2>&1 &
DEV_PID=$!
log "Dev server PID: $DEV_PID"

# Wait for dev server to start
sleep 5

# Check if dev server is running
if ! kill -0 $DEV_PID 2>/dev/null; then
    log "ERROR: Dev server failed to start"
    cat /tmp/opencode-dev-${TIMESTAMP}.log
    exit 1
fi

log "Dev server is running"

# Start a new opencode session in a way we can interact with
log "Starting urxvt with opencode..."
urxvt -geometry 120x40 -name "scrollbar-test" -e bash -c "echo 'Waiting for dev server...' && sleep 3 && opencode" &
URXVT_PID=$!
log "urxvt PID: $URXVT_PID"

sleep 5

# Get the urxvt window ID
sleep 2
URXVT_WID=$(xdotool search --name "scrollbar-test" 2>/dev/null | head -1 || echo "")
if [ -z "$URXVT_WID" ]; then
    # Try alternative window names
    URXVT_WID=$(xdotool search --name "urxvt" 2>/dev/null | head -1 || echo "")
fi

if [ -z "$URXVT_WID" ]; then
    log "WARNING: Could not find test window, using any opencode window"
    URXVT_WID=$(xdotool search --class "opencode" 2>/dev/null | head -1 || echo "")
fi

if [ -z "$URXVT_WID" ]; then
    log "ERROR: Could not find any window"
    kill $DEV_PID 2>/dev/null || true
    kill $XEPHYR_PID 2>/dev/null || true
    exit 1
fi

log "Window ID: $URXVT_WID"

# Focus the window
xdotool windowfocus "$URXVT_WID"
sleep 1

# Get window geometry
eval "$(xdotool getwindowgeometry --shell "$URXVT_WID")"
log "Window at: $X,$Y (${WIDTH}x${HEIGHT})"

# Test: Type to create scrollable content
log "Typing content to create scrollable conversation..."
xdotool type "Hello, this is a test. "
sleep 0.5
for i in {1..30}; do
    xdotool type "Paragraph $i with some text to make the conversation longer. "
    xdotool key Return
    sleep 0.1
done

log "Content typed. Waiting for TUI to render..."
sleep 3

# Test: Move mouse to the scrollbar area and hover
SCROLLBAR_X=$((X + WIDTH - 5))
SCROLLBAR_Y=$((Y + HEIGHT / 2))

log "Initial position: ($SCROLLBAR_X, $SCROLLBAR_Y)"

# Take initial screenshot
import -window "$URXVT_WID" "/tmp/scrollbar-before-${TIMESTAMP}.png" 2>/dev/null || log "Screenshot before failed"

# Move mouse to scrollbar and hover for 3 seconds
log "Moving mouse to scrollbar and hovering for 3 seconds (WITHOUT clicking)..."
xdotool mousemove $SCROLLBAR_X $SCROLLBAR_Y
sleep 3

# Take screenshot after hovering
import -window "$URXVT_WID" "/tmp/scrollbar-after-${TIMESTAMP}.png" 2>/dev/null || log "Screenshot after failed"

# Move mouse away
xdotool mousemove $((X + 100)) $((Y + 100))
sleep 1

log ""
log "=== TEST COMPLETE ==="
log ""

# Cleanup
kill $URXVT_PID 2>/dev/null || true
kill $DEV_PID 2>/dev/null || true
kill $XEPHYR_PID 2>/dev/null || true

echo "Results:"
echo "  Before screenshot: /tmp/scrollbar-before-${TIMESTAMP}.png"
echo "  After screenshot: /tmp/scrollbar-after-${TIMESTAMP}.png"
echo "  Dev log: /tmp/opencode-dev-${TIMESTAMP}.log"
echo ""
echo "If the conversation scrolled while hovering (without clicking),"
echo "the bug is still present."
echo "If the conversation did NOT scroll, the fix works!"
