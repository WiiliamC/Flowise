#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "$SCRIPT_DIR/../packages/server/bin" && pwd)"

mapfile -t candidates < <(pgrep -f '(^|[[:space:]/])run[[:space:]]+start([[:space:]]|$)' || true)
pids=()

for pid in "${candidates[@]}"; do
    if [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" == "$SERVER_DIR" ]]; then
        pids+=("$pid")
    fi
done

if (( ${#pids[@]} == 0 )); then
    echo "Flowise is not running."
    exit 0
fi

echo "Stopping Flowise (PID: ${pids[*]})..."
kill -TERM "${pids[@]}"

# Flowise allows up to 30 seconds for graceful shutdown.
for (( attempt = 0; attempt < 35; attempt++ )); do
    remaining=()
    for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            remaining+=("$pid")
        fi
    done

    if (( ${#remaining[@]} == 0 )); then
        echo "Flowise stopped."
        exit 0
    fi

    sleep 1
done

echo "Graceful shutdown timed out; forcing Flowise to stop (PID: ${remaining[*]})."
kill -KILL "${remaining[@]}" 2>/dev/null || true
