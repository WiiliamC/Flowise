#!/usr/bin/env bash

# Configure the local Flowise deployment to use its bundled model catalog.
# Running this script recreates the service container without rebuilding its image.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${FLOWISE_ENV_FILE:-$PROJECT_ROOT/docker/.env.local}"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose-local.yml"
MODEL_FILE='/usr/src/flowise/packages/components/models.json'

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
    echo "Usage: bash scripts/use_local_model_prices.sh"
    echo "Backs up configuration and recreates Flowise using the bundled model catalog."
    echo "Set FLOWISE_ENV_FILE to an absolute path to use another environment file."
    exit 0
fi
[[ $# -eq 0 ]] || { echo 'Unexpected arguments; use --help.' >&2; exit 1; }

for command_name in docker python3 curl; do
    command -v "$command_name" >/dev/null || { echo "Missing command: $command_name" >&2; exit 1; }
done
[[ -f "$ENV_FILE" ]] || { echo "Configuration not found: $ENV_FILE" >&2; exit 1; }
ENV_FILE="$(realpath -- "$ENV_FILE")"
set -a
# Match the configuration loading used by flowise_service.sh.
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${FLOWISE_CONTAINER_NAME:?FLOWISE_CONTAINER_NAME is required}"
: "${FLOWISE_PORT:?FLOWISE_PORT is required}"
: "${FLOWISE_PROJECT_NAME:=flowise-local}"

if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
else
    echo 'Docker Compose is required.' >&2
    exit 1
fi

echo 'Checking the bundled model catalog...'
docker exec "$FLOWISE_CONTAINER_NAME" node -e '
const fs = require("fs");
JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log("Model catalog is readable and valid JSON.");
' "$MODEL_FILE"

python3 - "$ENV_FILE" "$COMPOSE_FILE" "$MODEL_FILE" <<'PY'
from pathlib import Path
from datetime import datetime
import re
import shutil
import sys

env_file, compose_file = map(Path, sys.argv[1:3])
value = sys.argv[3]
env_text = env_file.read_text()
compose_text = compose_file.read_text()

env_line = f"MODEL_LIST_CONFIG_JSON={value}"
env_pattern = r"(?m)^[ \t]*(?:export[ \t]+)?MODEL_LIST_CONFIG_JSON=.*$"
if re.search(env_pattern, env_text):
    new_env = re.sub(env_pattern, lambda _: env_line, env_text)
else:
    new_env = env_text.rstrip("\n") + "\n" + env_line + "\n"

compose_line = "            MODEL_LIST_CONFIG_JSON: ${MODEL_LIST_CONFIG_JSON}"
compose_pattern = r"(?m)^ {12}MODEL_LIST_CONFIG_JSON:.*$"
if re.search(compose_pattern, compose_text):
    new_compose = re.sub(compose_pattern, lambda _: compose_line, compose_text)
else:
    anchor = "        environment:\n"
    if compose_text.count(anchor) != 1:
        raise SystemExit("Cannot uniquely locate environment block; no files changed.")
    new_compose = compose_text.replace(anchor, anchor + compose_line + "\n", 1)

stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
for path in (env_file, compose_file):
    backup = path.with_name(f"{path.name}.bak.{stamp}")
    shutil.copy2(path, backup)
    print(f"Backup: {backup}")

env_file.write_text(new_env)
compose_file.write_text(new_compose)
print("Configuration updated.")
PY

# Override any previous value exported when loading the environment file.
export MODEL_LIST_CONFIG_JSON="$MODEL_FILE"
"${COMPOSE[@]}" --env-file "$ENV_FILE" --project-name "$FLOWISE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" config --quiet

echo 'Recreating Flowise; service will be briefly interrupted...'
FLOWISE_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/flowise_service.sh" restart

docker exec "$FLOWISE_CONTAINER_NAME" node -e '
const fs = require("fs");
const expected = process.argv[1];
if (process.env.MODEL_LIST_CONFIG_JSON !== expected) {
    throw new Error("MODEL_LIST_CONFIG_JSON did not take effect");
}
JSON.parse(fs.readFileSync(expected, "utf8"));
console.log("Local model catalog configuration verified:", expected);
' "$MODEL_FILE"

echo 'Waiting for Flowise readiness...'
ready=false
for attempt in {1..40}; do
    if curl --fail --silent --show-error --max-time 1 \
        "http://localhost:${FLOWISE_PORT}/api/v1/ping" >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 2
done

if [[ "$ready" != true ]]; then
    echo 'Flowise did not become ready. Recent container logs:' >&2
    docker logs --tail 100 "$FLOWISE_CONTAINER_NAME"
    exit 1
fi

FLOWISE_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/flowise_service.sh" status
echo 'Done. Repeat the huidian_entry request to verify end-of-stream latency.'
