#!/usr/bin/env bash
set -euo pipefail
# ── VibeMaestro compute entrypoint ──────────────────────────────────────────
# Runs TWO processes:
#   1. OpenCode server  — bound ONLY to loopback (127.0.0.1:4096), password-gated.
#      (CVE-2026-22812: unauthenticated RCE — must never be publicly reachable.)
#   2. Bridge (Node)    — the ONLY public port (8080). Validates vm_sid sessions,
#      injects the OpenCode password, proxies authorized requests to loopback.
: "${OPENCODE_SERVER_PASSWORD:=}"
: "${VM_SESSION:=}"

# 1) OpenCode on loopback only — no 6PN, no 0.0.0.0, no --mdns.
opencode serve --hostname 127.0.0.1 --port 4096 &
OC_PID=$!

# give OpenCode a moment to bind
sleep 3

# 2) Bridge on the public port (Fly maps :8080 -> https)
export OPENCODE_URL="http://127.0.0.1:4096"
export PORT=8080
export DATA_URL="https://data.example.com"
export PUBLISH_URL="https://publish.example.com"
export WORKSPACES_DIR="/workspaces"
mkdir -p /workspaces 2>/dev/null || true
node /app/bridge/server.js &
BR_PID=$!

# if either dies, take the machine down so Fly restarts it clean
wait -n "$OC_PID" "$BR_PID"
echo "a process exited; shutting down for clean restart"
kill "$OC_PID" "$BR_PID" 2>/dev/null || true
exit 1
