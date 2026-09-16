#!/usr/bin/env bash
# Aether Cloud OS — utility functions.
#
# Shared helpers used across the installation scripts. Logging and locking
# live in core.sh; this file only adds filesystem/env helpers.

# ---------------------------------------------------------------------------
# File and directory utilities
# ---------------------------------------------------------------------------
create_directory() {
    local dir="$1"
    if [ ! -d "$dir" ]; then
        info "Creating directory: $dir"
        mkdir -p "$dir"
    else
        info "Directory already exists: $dir"
    fi
}

# ---------------------------------------------------------------------------
# Environment variable utilities
# ---------------------------------------------------------------------------
set_env_var() {
    local key="$1"
    local value="$2"
    local env_file="$3"

    if [ -z "$env_file" ]; then
        env_file=".env"
    fi

    if grep -q "^$key=" "$env_file"; then
        sed -i "s|^$key=.*|$key=$value|" "$env_file"
    else
        echo "$key=$value" >> "$env_file"
    fi

    info "Set environment variable: $key=$value"
}

# ---------------------------------------------------------------------------
# Docker utilities
# ---------------------------------------------------------------------------
docker_pull() {
    local image="$1"
    info "Pulling Docker image: $image"
    docker pull "$image"
}

# Runs `docker` directly when the socket is already usable, and through sudo
# otherwise. $SUDO is set by preflight's permission check; when it is empty the
# invoking user is root or in the docker group.
docker_cmd() {
    if docker info >/dev/null 2>&1; then
        docker "$@"
    elif [ -n "${SUDO:-}" ]; then
        $SUDO docker "$@"
    else
        sudo docker "$@"
    fi
}

# Runs `docker compose`. Lives here rather than in deploy.sh because the post-
# install helper scripts (backup, restore, update, uninstall) are copied to the
# install directory *without* deploy.sh, so anything they need must be in
# core.sh or utils.sh.
compose_cmd() {
    docker_cmd compose "$@"
}

# Reads a single key out of an .env file without sourcing it.
#
# Sourcing would execute whatever is in the file and let a value override a
# shell variable of the same name. This only ever returns the value, with one
# layer of surrounding quotes removed to match how Compose parses the file.
#
# Prints nothing and returns 1 when the key is absent, so callers can supply
# their own default: `db=$(env_value POSTGRES_DB || true)`.
env_value() {
    local key="$1" file="$2" line
    [ -f "$file" ] || return 1
    line=$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n1) || return 1
    line="${line#*=}"
    case "$line" in
        \"*\") line="${line#\"}"; line="${line%\"}" ;;
        \'*\') line="${line#\'}"; line="${line%\'}" ;;
    esac
    printf '%s' "$line"
}

# ---------------------------------------------------------------------------
# System utilities
# ---------------------------------------------------------------------------
check_command() {
    local cmd="$1"
    if ! command -v "$cmd" &> /dev/null; then
        fatal "Command not found: $cmd"
    fi
}

check_root() {
    if [ "$(id -u)" -ne 0 ]; then
        fatal "This script must be run as root"
    fi
}
