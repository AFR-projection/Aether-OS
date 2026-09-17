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

# Builds the frontend bundle from source and installs it at
# $AETHER_INSTALL_DIR/static, replacing whatever is there.
#
# The builder image's `builder` stage already contains the compiled bundle; the
# container only copies it out, so the *host* needs no Node toolchain. It is
# built into ./static.new and swapped in only once it is complete, because that
# copy step empties its destination first — building straight into ./static
# would delete the frontend a running instance is serving, and a failure
# afterwards would leave an instance serving nothing.
#
# Returns non-zero instead of calling fatal: the installer, `aether update`, and
# `aether restore` all need this and only some of them can abort immediately.
#
# Always builds $AETHER_INSTALL_DIR/src — the tree the compose file points at.
# It takes no argument on purpose: a caller passing a different tree would get
# one built from `src` anyway, silently.
install_frontend_bundle() {
    local src_dir="$AETHER_INSTALL_DIR/src"
    local static_dir="$AETHER_INSTALL_DIR/static"
    local staging_dir="$AETHER_INSTALL_DIR/static.new"

    [ -f "$src_dir/packages/frontend/Dockerfile" ] || {
        error "No frontend source tree at $src_dir — cannot build the bundle."
        return 1
    }

    rm -rf "$staging_dir"

    # The compose file lives in ./state, NOT in the source tree. <install>/src is
    # a live git checkout that `aether update` fast-forwards, and its clean-tree
    # check counts untracked files — so a build artifact written there would make
    # every update refuse to run as "locally modified". Paths below are relative
    # to this file's directory (the compose project directory).
    mkdir -p "$AETHER_INSTALL_DIR/state"
    cat > "$AETHER_INSTALL_DIR/state/docker-compose.frontend.yml" <<'COMPOSE_EOF'
name: aether-frontend-build
services:
  frontend-build:
    build:
      context: ../src
      dockerfile: packages/frontend/Dockerfile
      target: builder
    entrypoint: ["sh", "-c", "rm -rf /out/* && cp -r /build/packages/frontend/dist/. /out/"]
    volumes:
      - ../static.new:/out
COMPOSE_EOF

    if ! compose_cmd -f "$AETHER_INSTALL_DIR/state/docker-compose.frontend.yml" \
        run --rm --build frontend-build; then
        rm -rf "$staging_dir"
        error "The frontend build failed. The existing bundle is untouched."
        return 1
    fi

    if [ ! -f "$staging_dir/index.html" ]; then
        rm -rf "$staging_dir"
        error "The frontend build produced no bundle (no index.html in $staging_dir)."
        return 1
    fi

    rm -rf "$AETHER_INSTALL_DIR/static.old"
    if [ -d "$static_dir" ]; then
        mv "$static_dir" "$AETHER_INSTALL_DIR/static.old"
    fi
    mv "$staging_dir" "$static_dir"
    rm -rf "$AETHER_INSTALL_DIR/static.old"

    info "Frontend bundle installed to $static_dir"
    return 0
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
