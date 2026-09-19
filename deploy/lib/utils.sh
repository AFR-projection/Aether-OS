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

    # The backend bind-mounts this directory. Replacing it with `mv` swaps the
    # inode, so a *running* backend keeps its mount pointed at the old (now
    # unlinked) directory and serves an empty static root — a 404 on `/` while
    # /health still answers. Docker only re-binds on container (re)creation.
    # Callers that rebuild the image (`aether update`) recreate it anyway, but a
    # frontend-only rebuild (`aether repair`, `--no-pull` with an unchanged
    # image) would not. Recreate it here so every path leaves a served bundle.
    # Guarded on "is the backend running": during a fresh install the container
    # does not exist yet and this is a no-op.
    if [ -f "$AETHER_INSTALL_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
        local running_backend
        running_backend=$(compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
            ps --status running backend 2>/dev/null || true)
        if matches "$running_backend" "backend"; then
            info "Re-binding the static mount into the running backend"
            compose_cmd -f "$AETHER_INSTALL_DIR/docker-compose.yml" \
                up -d --force-recreate --no-deps backend >/dev/null 2>&1 \
                || warn "Could not recreate the backend to pick up the new bundle; run 'aether restart'."
        fi
    fi

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
# PORT PREVIEWS — the one range that three files have to agree on
# ---------------------------------------------------------------------------
# A preview is served from the same host on a spare port, so the range appears
# in three places that cannot read each other: the backend's .env (where a
# preview may be served from), the published ports in docker-compose.yml (what
# Docker forwards), and the firewall (what the kernel accepts). Docker compose
# cannot expand a loop, so the range is written out here and substituted into
# each file by the installer.
#
# Defaults match the shipped docker-compose.prod.yml, so an install that never
# sets these still works.
AETHER_PREVIEW_PORT_START="${AETHER_PREVIEW_PORT_START:-8443}"
AETHER_PREVIEW_PORT_COUNT="${AETHER_PREVIEW_PORT_COUNT:-10}"

# The highest port in the range. Written as arithmetic rather than a loop
# because a shell loop cannot be interpolated into a compose file.
preview_port_end() {
    local start="$AETHER_PREVIEW_PORT_START"
    local count="$AETHER_PREVIEW_PORT_COUNT"
    local last

    case "$start" in
        ''|*[!0-9]*) fatal "AETHER_PREVIEW_PORT_START must be a port number (got '$start')" ;;
    esac
    case "$count" in
        ''|*[!0-9]*) fatal "AETHER_PREVIEW_PORT_COUNT must be a number (got '$count')" ;;
    esac

    last=$((start + count - 1))
    if [ "$count" -lt 1 ] || [ "$last" -gt 65535 ]; then
        fatal "The preview port range $start-$last is not usable"
    fi
    printf '%s' "$last"
}

# `8443-8452` — the host half of a compose port mapping, which is written as
# `8443-8452:8443-8452`. A ufw rule takes the range with a colon instead
# (`8443:8452/tcp`), which is what ensure_preview_firewall_rule builds.
preview_port_range() {
    printf '%s-%s' "$AETHER_PREVIEW_PORT_START" "$(preview_port_end)"
}

# ---------------------------------------------------------------------------
# APT — non-interactive, lock-aware
# ---------------------------------------------------------------------------
# apt and dpkg serialise through lock files under /var/lib. On a freshly
# provisioned VPS those are held by boot-time jobs nobody is watching:
# unattended-upgrades starts a security update on first boot, and cloud-init
# runs apt while it finishes provisioning. A bare `apt-get install` at that
# moment dies with "Could not get lock /var/lib/dpkg/lock-frontend" and takes
# the whole install down with it — on a machine nobody is even using yet.
#
# Every apt call in Aether therefore goes through apt_get, which waits for the
# lock, runs unattended, and retries.
#
# How long apt waits for the lock before giving up, in seconds. Longer than a
# realistic unattended-upgrades run, shorter than a person's patience for a
# hung install.
AETHER_APT_LOCK_TIMEOUT="${AETHER_APT_LOCK_TIMEOUT:-900}"

# Frees the lock a boot-time apt job is holding, so the install does not queue
# behind a security update it never asked to wait for.
#
# Stopping these is deliberately neither destructive nor permanent: they are
# timer-driven, so they return on their normal schedule, and
# unattended-upgrades finishes its current dpkg transaction before exiting.
# Nothing is disabled or masked.
aether_apt_prepare() {
    [ "${AETHER_SKIP_APT_PREPARE:-false}" = "true" ] && return 0

    # cloud-init installs packages while a new VPS provisions. Wait for it
    # rather than racing it — bounded, because a wedged cloud-init must not
    # hang the install forever.
    if systemctl is-active --quiet cloud-init 2>/dev/null && command_exists cloud-init; then
        info "Waiting for cloud-init to finish before using apt"
        timeout 300 cloud-init status --wait >/dev/null 2>&1 ||
            warn "cloud-init did not report completion within 5 minutes; continuing"
    fi

    local unit
    for unit in unattended-upgrades apt-daily.service apt-daily-upgrade.service; do
        if systemctl is-active --quiet "$unit" 2>/dev/null; then
            info "Pausing $unit to release the package lock (it resumes on its normal schedule)"
            $SUDO systemctl stop "$unit" >/dev/null 2>&1 || true
        fi
    done
}

# Runs apt-get the way an unattended install needs it:
#
#   DEBIAN_FRONTEND=noninteractive  a debconf prompt would otherwise block a
#                                   piped `curl | bash` forever, with no one
#                                   attached to answer it
#   DPkg::Lock::Timeout             wait for a held lock instead of dying
#   Acquire::Retries                ride out a flaky mirror
#
# Retries the whole command on failure: a first-boot VPS routinely fails an apt
# run with a transient mirror or lock error that succeeds seconds later.
apt_get() {
    local attempts="${AETHER_APT_ATTEMPTS:-3}"
    local attempt=1 status=0

    aether_apt_prepare

    while true; do
        status=0
        # `$SUDO env …` rather than `env … $SUDO …`: sudo resets the
        # environment, so a variable set before it is dropped for a non-root
        # operator. Setting it on the far side of sudo reaches apt either way.
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get \
            -o DPkg::Lock::Timeout="$AETHER_APT_LOCK_TIMEOUT" \
            -o Dpkg::Use-Pty=0 \
            -o Acquire::Retries=3 \
            "$@" || status=$?

        if [ "$status" -eq 0 ]; then
            return 0
        fi

        if [ "$attempt" -ge "$attempts" ]; then
            error "apt-get $* failed after ${attempt} attempt(s) (exit ${status})"
            return "$status"
        fi

        warn "apt-get failed (exit ${status}); retrying in $((attempt * 5))s (attempt $((attempt + 1))/${attempts})"
        sleep $((attempt * 5))
        attempt=$((attempt + 1))
    done
}

# ---------------------------------------------------------------------------
# Swap
# ---------------------------------------------------------------------------
AETHER_SWAPFILE="${AETHER_SWAPFILE:-/swapfile}"
# Total swap to aim for on a low-memory host. Many VPS images ship a small
# provider-managed swap (a few hundred MB) which is not enough headroom on its
# own, so this is a target for the total, not the size of a new file.
AETHER_SWAP_TARGET_MB="${AETHER_SWAP_TARGET_MB:-2048}"

# A 1–2 GB VPS has no headroom for a frontend image build plus the host agent's
# node-pty compile. When it runs out, the kernel OOM-killer turns a healthy
# build into a SIGABRT (exit 134) that reads like a compiler bug and costs the
# operator an hour. Swap is the difference between an install that finishes and
# one that fails for reasons that look like a code defect.
#
# Counts the swap the host already has — most VPS images ship a few hundred MB,
# which is not enough on its own — and tops it up to the target. Never fatal: a
# host that cannot take a swapfile still installs, just more slowly.
ensure_swap() {
    local ram_mb="$1"
    local swap_mb add_mb

    if [ "${AETHER_NO_SWAP:-false}" = "true" ]; then
        warn "  Swap provisioning disabled (AETHER_NO_SWAP); builds on a ${ram_mb} MB host may be OOM-killed."
        return 0
    fi
    if [ "${AETHER_DRY_RUN:-false}" = "true" ]; then
        warn "  Dry run: would bring swap up to ${AETHER_SWAP_TARGET_MB} MB so builds are not OOM-killed."
        return 0
    fi

    swap_mb=$(free -m | awk '/^Swap:/{print $2}')
    swap_mb="${swap_mb:-0}"

    if [ "$swap_mb" -ge "$AETHER_SWAP_TARGET_MB" ]; then
        info "Swap is already ${swap_mb} MB (target ${AETHER_SWAP_TARGET_MB} MB); leaving it alone"
        return 0
    fi

    add_mb=$((AETHER_SWAP_TARGET_MB - swap_mb))

    # Leave the last gigabyte of disk to the install itself; shrink the file
    # rather than skipping it, since partial swap still beats none.
    local avail_mb
    avail_mb=$(df -BM --output=avail / | tail -1 | tr -dc '0-9')
    avail_mb="${avail_mb:-0}"
    if [ "$avail_mb" -lt $((add_mb + 1024)) ]; then
        add_mb=$((avail_mb - 1024))
    fi
    if [ "$add_mb" -lt 256 ]; then
        warn "Not enough free disk to extend swap (${avail_mb} MB free)."
        warn "  Builds on a ${ram_mb} MB host may be OOM-killed; add swap manually if one fails:"
        warn "    fallocate -l 2G $AETHER_SWAPFILE && chmod 600 $AETHER_SWAPFILE && mkswap $AETHER_SWAPFILE && swapon $AETHER_SWAPFILE"
        return 0
    fi

    if [ -e "$AETHER_SWAPFILE" ]; then
        warn "$AETHER_SWAPFILE exists but is not active; leaving it untouched."
        return 0
    fi

    info "Low memory (${ram_mb} MB) with ${swap_mb} MB swap — adding ${add_mb} MB so builds are not OOM-killed"

    # fallocate is instant but unsupported on a few filesystems; dd always works.
    if ! $SUDO fallocate -l "${add_mb}M" "$AETHER_SWAPFILE" 2>/dev/null; then
        if ! $SUDO dd if=/dev/zero of="$AETHER_SWAPFILE" bs=1M count="$add_mb" status=none 2>/dev/null; then
            warn "Could not create $AETHER_SWAPFILE; continuing without extra swap."
            $SUDO rm -f "$AETHER_SWAPFILE" 2>/dev/null || true
            return 0
        fi
    fi

    $SUDO chmod 600 "$AETHER_SWAPFILE"

    if ! $SUDO mkswap "$AETHER_SWAPFILE" >/dev/null 2>&1 || ! $SUDO swapon "$AETHER_SWAPFILE" 2>/dev/null; then
        warn "Could not enable $AETHER_SWAPFILE; removing it and continuing without extra swap."
        $SUDO swapoff "$AETHER_SWAPFILE" 2>/dev/null || true
        $SUDO rm -f "$AETHER_SWAPFILE" 2>/dev/null || true
        return 0
    fi

    # Record it, or a reboot drops the swap and brings the OOM failure back.
    if grep -qs "^${AETHER_SWAPFILE}[[:space:]]" /etc/fstab; then
        info "Swap extended to $((swap_mb + add_mb)) MB; /etc/fstab already lists it"
    elif printf '%s none swap sw 0 0\n' "$AETHER_SWAPFILE" | $SUDO tee -a /etc/fstab >/dev/null 2>&1; then
        info "Swap extended to $((swap_mb + add_mb)) MB and recorded in /etc/fstab"
    else
        warn "Swap extended to $((swap_mb + add_mb)) MB for this boot, but /etc/fstab could not be updated."
    fi
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
