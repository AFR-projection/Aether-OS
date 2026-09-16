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
