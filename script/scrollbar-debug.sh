#!/bin/bash
# Script to reproduce and debug the scrollbar hover scroll bug
# This script uses `script` to record input/output for debugging

set -e

LOGFILE="/tmp/scrollbar-debug-$(date +%s).log"
RECORDFILE="/tmp/scrollbar-session-$(date +%s).log"

echo "=== Scrollbar Hover Scroll Bug Reproduction Script ===" | tee "$LOGFILE"
echo "Log file: $LOGFILE" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

# Function to log with timestamp
log() {
    echo "[$(date '+%H:%M:%S.%3N')] $*" | tee -a "$LOGFILE"
}

# Check if required tools are available
check_deps() {
    log "Checking dependencies..."
    for cmd in xdotool import scrot xprop; do
        if ! command -v $cmd &>/dev/null; then
            log "WARNING: $cmd not found - some features may not work"
        fi
    done
}

# Get the browser window ID
get_window_id() {
    xdotool search --name "Mozilla Firefox" 2>/dev/null | head -1 || \
    xdotool search --name "Chromium" 2>/dev/null | head -1 || \
    xdotool search --name "Chrome" 2>/dev/null | head -1 || \
    echo ""
}

# Open the app
open_app() {
    log "Opening app at http://localhost:4444..."
    urxvt -e bash -c "echo 'Starting browser...' && firefox http://localhost:4444" &
    sleep 5
}

# Create test content by typing
create_test_content() {
    log "Creating test content by typing..."
    
    WID=$(get_window_id)
    if [ -z "$WID" ]; then
        log "ERROR: Browser window not found"
        return 1
    fi
    
    xdotool windowfocus "$WID"
    sleep 1
    
    # Type some text to create a conversation
    xdotool key Tab Tab
    sleep 0.5
    
    for i in {1..5}; do
        xdotool type "Write some detailed paragraphs about software development and testing. "
        xdotool key Return
        sleep 0.3
    done
    
    log "Test content created"
}

# Move mouse over scrollbar and check for scroll
test_scrollbar_hover() {
    log "Testing scrollbar hover behavior..."
    
    WID=$(get_window_id)
    if [ -z "$WID" ]; then
        log "ERROR: Browser window not found"
        return 1
    fi
    
    xdotool windowfocus "$WID"
    sleep 0.5
    
    # Get window geometry
    eval "$(xdotool getwindowgeometry --shell "$WID")"
    log "Window: $WID at $X,$Y (${WIDTH}x${HEIGHT})"
    
    # Get initial scroll position
    SCROLL_POS_BEFORE=$(xprop -id "$WID" _NET_WM_VISIBLE_NAME 2>/dev/null || echo "unknown")
    
    # Position mouse over the scrollbar (right side of the window)
    SCROLLBAR_X=$((X + WIDTH - 20))
    SCROLLBAR_Y=$((Y + HEIGHT / 2))
    
    log "Moving mouse to scrollbar position: ($SCROLLBAR_X, $SCROLLBAR_Y)"
    xdotool mousemove "$SCROLLBAR_X" "$SCROLLBAR_Y"
    
    # Wait a bit and check for scroll events
    log "Waiting 2 seconds while hovering over scrollbar..."
    sleep 2
    
    # Check if scrolling happened by looking at the viewport
    # In a real test, we'd use browser DevTools Protocol
    log "Hover test completed"
    
    # Take screenshot for verification
    import -window "$WID" "/tmp/scrollbar-hover-test.png" 2>/dev/null || true
    log "Screenshot saved to /tmp/scrollbar-hover-test.png"
}

# Add debug listeners to the app (requires page reload with console logging)
inject_debug() {
    log "Note: To see scroll events, open browser DevTools (F12) and check Console"
    log "Look for: ScrollEvent, pointermove, wheel events"
}

# Main execution
main() {
    check_deps
    open_app
    sleep 3
    create_test_content
    test_scrollbar_hover
    inject_debug
    
    log ""
    log "=== Test Complete ==="
    log "Check /tmp/scrollbar-*.log for detailed logs"
    log "Check /tmp/scrollbar-*.png for screenshots"
}

# Run with script to record session
script -f "$RECORDFILE" -c "$(basename $0)" 2>/dev/null || main
