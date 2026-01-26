#!/bin/bash
# Build and run Claude Monitor

cd "$(dirname "$0")"

# Kill any existing instance
killall ClaudeMonitor 2>/dev/null

# Build
swift build

# Run in background
.build/debug/ClaudeMonitor &

echo "Claude Monitor started (snowboarder icon in menubar)"
