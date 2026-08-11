#!/usr/bin/env bash

# export ENABLE_TOOL_CALL_COMPLETED_EVENT=true

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root" || exit 1

mkdir -p logs
nohup sh -c 'pnpm build && pnpm start' >> logs/launch.log 2>&1 &

echo "Flowise is starting in the background (PID: $!). Logs: $project_root/logs/launch.log"
