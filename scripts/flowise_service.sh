#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/docker-compose-local.yml"
ENV_FILE="${FLOWISE_ENV_FILE:-$PROJECT_ROOT/docker/.env.local}"
# Capture the caller's environment before loading project configuration.
BUILD_ENV_PROXY="${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}"

COMPOSE=()

usage() {
    cat <<'EOF'
Usage: ./scripts/flowise_service.sh <command> [options]

Commands:
  build [--no-cache] [--proxy]
                      Build the image; direct connections by default
  start               Start the Flowise container without rebuilding
  stop                Gracefully stop the Flowise container
  restart             Restart the running Flowise container
  status              Show container, image, port, and health information
  logs                Follow the latest 200 log lines (Ctrl+C to exit)
  help                 Show this help message

Configuration:
  docker/.env.local

To use another configuration file, set FLOWISE_ENV_FILE to its absolute path.

Build proxy (Linux with a local Docker daemon):
  --proxy enables the local HTTP/HTTPS proxy from the first non-empty variable:
  https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY.
  The proxy must use localhost, 127.0.0.1, or [::1]. Proxy builds use host networking.
  Without --proxy, build proxy arguments are explicitly cleared.
  With sudo, preserve the variables explicitly:
    sudo --preserve-env=http_proxy,https_proxy,HTTP_PROXY,HTTPS_PROXY \
      bash scripts/flowise_service.sh build --proxy
  This controls build RUN steps, not Docker daemon image downloads.
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

load_config() {
    [[ -f "$ENV_FILE" ]] || die "configuration file not found: $ENV_FILE (copy docker/.env.local.example first)"

    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a

    : "${FLOWISE_PROJECT_NAME:=flowise-local}"
    : "${FLOWISE_IMAGE:?FLOWISE_IMAGE is required in $ENV_FILE}"
    : "${FLOWISE_CONTAINER_NAME:?FLOWISE_CONTAINER_NAME is required in $ENV_FILE}"
    : "${FLOWISE_PORT:?FLOWISE_PORT is required in $ENV_FILE}"
    : "${FLOWISE_DATA_DIR:?FLOWISE_DATA_DIR is required in $ENV_FILE}"
    : "${ENABLE_TOOL_CALL_COMPLETED_EVENT:=true}"

    [[ "$FLOWISE_PORT" =~ ^[0-9]+$ ]] || die "FLOWISE_PORT must be a number"
    (( FLOWISE_PORT >= 1 && FLOWISE_PORT <= 65535 )) || die "FLOWISE_PORT must be between 1 and 65535"

    export FLOWISE_PROJECT_NAME FLOWISE_IMAGE FLOWISE_CONTAINER_NAME FLOWISE_PORT FLOWISE_DATA_DIR
    export ENABLE_TOOL_CALL_COMPLETED_EVENT
}

select_compose() {
    command -v docker >/dev/null 2>&1 || die "Docker is not installed or is not available in PATH"

    if docker compose version >/dev/null 2>&1; then
        COMPOSE=(docker compose)
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE=(docker-compose)
    else
        die "Docker Compose is not installed"
    fi
}

check_docker() {
    docker info >/dev/null 2>&1 || die "cannot connect to the Docker daemon"
}

compose() {
    "${COMPOSE[@]}" \
        --env-file "$ENV_FILE" \
        --project-name "$FLOWISE_PROJECT_NAME" \
        --file "$COMPOSE_FILE" \
        "$@"
}

validate_data_dir() {
    [[ "$FLOWISE_DATA_DIR" == /* ]] || die "FLOWISE_DATA_DIR must be an absolute path"
    [[ -d "$FLOWISE_DATA_DIR" ]] || die "data directory does not exist: $FLOWISE_DATA_DIR"
    docker run --rm \
        --user 1000:1000 \
        --entrypoint /bin/sh \
        --volume "$FLOWISE_DATA_DIR:/data" \
        "$FLOWISE_IMAGE" \
        -c 'test -w /data' >/dev/null 2>&1 || \
        die "data directory is not writable by the Flowise container user (UID/GID 1000): $FLOWISE_DATA_DIR"
}

container_owns_port() {
    [[ "$(docker container inspect --format '{{.State.Running}}' "$FLOWISE_CONTAINER_NAME" 2>/dev/null)" == "true" ]] || return 1
    docker port "$FLOWISE_CONTAINER_NAME" "${FLOWISE_PORT}/tcp" 2>/dev/null | \
        awk -F: -v port="$FLOWISE_PORT" '$NF == port { found = 1 } END { exit !found }'
}

port_is_listening() {
    command -v ss >/dev/null 2>&1 || return 1
    ss -H -ltn 2>/dev/null | awk -v port="$FLOWISE_PORT" '$4 ~ (":" port "$") { found = 1 } END { exit !found }'
}

check_start_preconditions() {
    docker image inspect "$FLOWISE_IMAGE" >/dev/null 2>&1 || \
        die "image '$FLOWISE_IMAGE' does not exist; run '$0 build' first"
    validate_data_dir

    if port_is_listening && ! container_owns_port; then
        die "port $FLOWISE_PORT is already in use"
    fi
}

build_image() (
    local build_args=(build)
    local compose_args=()
    local use_proxy=false no_cache=false proxy_url='' bypass='' proxy_override=''
    local option proxy_name proxy_port

    for option in "$@"; do
        case "$option" in
            --proxy)
                [[ "$use_proxy" == false ]] || die "duplicate build option: --proxy"
                use_proxy=true
                ;;
            --no-cache)
                [[ "$no_cache" == false ]] || die "duplicate build option: --no-cache"
                no_cache=true
                build_args+=(--no-cache)
                ;;
            *) die "unknown build option (use build --proxy without a value, and/or --no-cache)" ;;
        esac
    done

    if [[ "$use_proxy" == true ]]; then
        proxy_url="$BUILD_ENV_PROXY"
        [[ -n "$proxy_url" ]] || die "--proxy requires an HTTP/HTTPS proxy environment variable; with sudo use --preserve-env=http_proxy,https_proxy,HTTP_PROXY,HTTPS_PROXY (ALL_PROXY alone is not supported)"
        # Do not print the URL: it may contain credentials.
        local proxy_pattern='^https?://([^/@[:space:]]+@)?(localhost|127\.0\.0\.1|\[::1\])(:([0-9]{1,5}))?/?$'
        [[ "$proxy_url" =~ $proxy_pattern ]] || die "--proxy requires an http:// or https:// URL using localhost, 127.0.0.1, or [::1], with an optional valid port"
        proxy_port="${BASH_REMATCH[4]}"
        if [[ -n "$proxy_port" ]]; then
            (( 10#$proxy_port >= 1 && 10#$proxy_port <= 65535 )) || die "proxy port must be between 1 and 65535"
        fi
        bypass='localhost,127.0.0.1,::1'
        proxy_override="$(mktemp "${TMPDIR:-/tmp}/flowise-build-proxy.XXXXXX")"
        trap 'rm -f -- "$proxy_override"' EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        cat > "$proxy_override" <<'EOF'
services:
  flowise:
    build:
      network: host
EOF
        compose_args+=(--file "$proxy_override")
        echo "Build proxy enabled from environment; using host build networking."
    else
        echo "Build proxy disabled; using direct connections for build RUN steps."
    fi

    # Explicit empty values override Docker client proxies, including root's config.
    for proxy_name in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
        build_args+=(--build-arg "$proxy_name=$proxy_url")
    done
    for proxy_name in ALL_PROXY all_proxy; do
        build_args+=(--build-arg "$proxy_name=")
    done
    for proxy_name in NO_PROXY no_proxy; do
        build_args+=(--build-arg "$proxy_name=$bypass")
    done
    echo "Building image $FLOWISE_IMAGE..."
    compose "${compose_args[@]}" "${build_args[@]}" flowise
)

start_service() {
    check_start_preconditions
    echo "Starting $FLOWISE_CONTAINER_NAME..."
    compose up --detach --no-build flowise
    compose ps
}

stop_service() {
    echo "Stopping $FLOWISE_CONTAINER_NAME..."
    compose stop flowise
}

restart_service() {
    docker container inspect "$FLOWISE_CONTAINER_NAME" >/dev/null 2>&1 || \
        die "container '$FLOWISE_CONTAINER_NAME' has not been created; run '$0 start' first"
    check_start_preconditions
    echo "Restarting $FLOWISE_CONTAINER_NAME..."
    compose up --detach --no-build --force-recreate flowise
    compose ps
}

show_status() {
    compose ps

    if ! docker container inspect "$FLOWISE_CONTAINER_NAME" >/dev/null 2>&1; then
        echo "Container '$FLOWISE_CONTAINER_NAME' has not been created."
        return 0
    fi

    echo
    docker container inspect --format \
        'Container={{.Name}}
Image={{.Config.Image}}
State={{.State.Status}}
Health={{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}
StartedAt={{.State.StartedAt}}' \
        "$FLOWISE_CONTAINER_NAME"

    echo "Ports:"
    docker port "$FLOWISE_CONTAINER_NAME" 2>/dev/null || true
}

show_logs() {
    docker container inspect "$FLOWISE_CONTAINER_NAME" >/dev/null 2>&1 || \
        die "container '$FLOWISE_CONTAINER_NAME' has not been created"
    compose logs --tail=200 --follow flowise
}

main() {
    local command="${1:-help}"
    if (( $# > 0 )); then
        shift
    fi

    case "$command" in
        help|-h|--help)
            usage
            return 0
            ;;
        build|start|stop|restart|status|logs)
            load_config
            select_compose
            check_docker
            ;;
        *)
            usage >&2
            die "unknown command: $command"
            ;;
    esac

    case "$command" in
        build)
            build_image "$@"
            ;;
        start)
            (( $# == 0 )) || die "start does not accept arguments"
            start_service
            ;;
        stop)
            (( $# == 0 )) || die "stop does not accept arguments"
            stop_service
            ;;
        restart)
            (( $# == 0 )) || die "restart does not accept arguments"
            restart_service
            ;;
        status)
            (( $# == 0 )) || die "status does not accept arguments"
            show_status
            ;;
        logs)
            (( $# == 0 )) || die "logs does not accept arguments"
            show_logs
            ;;
    esac
}

main "$@"
