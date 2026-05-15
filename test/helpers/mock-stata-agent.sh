#!/bin/bash
# Wrapper that invokes the Node.js mock daemon.
# This is registered as the "stata-agent" binary for integration tests
# when the real Python binary isn't available.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/mock-daemon.js" "$@"
