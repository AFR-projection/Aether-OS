#!/usr/bin/env bash
# Aether Cloud OS — service deployment.
#
# Assembles the runtime layout under $AETHER_INSTALL_DIR:
#   src/                 application source (rsync of the repo, or a git clone)
#   static/              the built frontend the backend serves from disk
#   caddy/Caddyfile      reverse-proxy config with this instance's domain
#   docker-compose.yml   the production compose file
# then builds the backend image and starts the stack.
#
# Everything here is idempotent: re-running rebuilds what changed and leaves
# named volumes (database, workspace) untouched.

# `compose_cmd` and `docker_cmd` are defined in utils.sh, which install.sh
# sources before this file, and which is copied beside the post-install helper
# scripts so they share the same definition.

sync_source() {
    local src="$AETHER_REPO_DIR"

    if [ ! -f "$src/package.json" ]; then
        info "No local repo at $src — cloning from GitHub"
        mkdir -p "$(dirname "$AETHER_INSTALL_DIR/src")"
        git clone --depth 1 https://github.com/AFR-projection/Aether-OS.git "$AETHER_INSTALL_DIR/src"
        return
    fi

    info "Syncing application source from $src"
    mkdir -p "$AETHER_INSTALL_DIR/src"
    if command_exists rsync; then
        rsync -a --delete \
            --exclude node_modules --exclude .git --exclude dist \
            --exclude '*.tsbuildinfo' --exclude .env \
            "$src/" "$AETHER_INSTALL_DIR/src/"
    else
        # tar-copy fallback for images without rsync.
        (cd "$src" && tar cf - \
            --exclude=./node_modules --exclude=./.git --exclude=./*/dist \
            --exclude=./*/node_modules --exclude=./.env .) \
            | (cd "$AETHER_INSTALL_DIR/src" && tar xf -)
    fi
}

write_frontend_build_compose() {
    # One-off builder: the image's builder stage already contains the built
    # bundle at /build/packages/frontend/dist; this entrypoint just copies it
    # into ./static mounted from the host. The host needs no Node toolchain.
    cat > "${AETHER_INSTALL_DIR}/src/docker-compose.frontend.yml" <<'COMPOSE_EOF'
name: aether-frontend-build
services:
  frontend-build:
    build:
      context: .
      dockerfile: packages/frontend/Dockerfile
      target: builder
    entrypoint: ["sh", "-c", "rm -rf /out/* && cp -r /build/packages/frontend/dist/. /out/"]
    volumes:
      - ../static:/out
COMPOSE_EOF
}

build_frontend_bundle() {
    local static_dir="$AETHER_INSTALL_DIR/static"
    mkdir -p "$static_dir"

    if [ -f "$static_dir/index.html" ] && [ "${AETHER_FORCE_BUILD:-}" != "true" ]; then
        info "Frontend bundle already present — skipping (AETHER_FORCE_BUILD=true to force)"
        return
    fi

    stage "Building frontend bundle"
    write_frontend_build_compose
    compose_cmd -f "${AETHER_INSTALL_DIR}/src/docker-compose.frontend.yml" run --rm --build frontend-build

    [ -f "$static_dir/index.html" ] || fatal "Frontend build produced no bundle at $static_dir"
    info "Frontend bundle installed to $static_dir"
}

write_caddyfile() {
    local caddy_dir="$AETHER_INSTALL_DIR/caddy"
    mkdir -p "$caddy_dir"

    if [ -n "${AETHER_DOMAIN:-}" ] && [ "${AETHER_NO_HTTPS:-false}" != "true" ]; then
        cp "${AETHER_INSTALL_DIR}/src/deploy/Caddyfile" "$caddy_dir/Caddyfile"
        info "Caddyfile installed (HTTPS domain mode)"
    else
        # IP-only and --no-https modes use an explicit HTTP listener. An empty
        # Caddy site address is invalid and would prevent the proxy starting.
        if [ -n "${AETHER_DOMAIN:-}" ]; then
            sed 's|^{\$AETHER_DOMAIN} {|http://{\$AETHER_DOMAIN} {|' \
                "${AETHER_INSTALL_DIR}/src/deploy/Caddyfile" > "$caddy_dir/Caddyfile"
            info "Caddyfile installed (HTTP-only domain mode)"
        else
            awk '{ if ($0 == "{$AETHER_DOMAIN} {") print ":80 {"; else print }' \
                "${AETHER_INSTALL_DIR}/src/deploy/Caddyfile" > "$caddy_dir/Caddyfile"
            info "Caddyfile installed (HTTP IP-only mode)"
        fi
    fi
}

install_compose_file() {
    cp "${AETHER_INSTALL_DIR}/src/docker-compose.prod.yml" "${AETHER_INSTALL_DIR}/docker-compose.yml"
    # The compose file mounts ./deploy/Caddyfile and ./packages/frontend/dist
    # relative to itself — mirror those paths into the install root.
    mkdir -p "${AETHER_INSTALL_DIR}/deploy" "${AETHER_INSTALL_DIR}/packages/frontend"
    ln -sfn "$AETHER_INSTALL_DIR/caddy/Caddyfile" "${AETHER_INSTALL_DIR}/deploy/Caddyfile"
    ln -sfn "$AETHER_INSTALL_DIR/static" "${AETHER_INSTALL_DIR}/packages/frontend/dist"
    info "docker-compose.yml installed at ${AETHER_INSTALL_DIR}/docker-compose.yml"
}

start_services() {
    stage "Starting services"
    cd "$AETHER_INSTALL_DIR"
    compose_cmd pull --quiet 2>/dev/null || true
    compose_cmd build backend
    compose_cmd up -d
    cd - >/dev/null
}

deploy_application() {
    sync_source
    write_caddyfile
    install_compose_file
    build_frontend_bundle
    start_services
}
