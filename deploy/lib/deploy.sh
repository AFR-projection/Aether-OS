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
# Everything here is idempotent: re-running rebuilds what changed and leaves the
# database volume and the host data directory untouched.

# `compose_cmd` and `docker_cmd` are defined in utils.sh, which install.sh
# sources before this file, and which is copied beside the post-install helper
# scripts so they share the same definition.

sync_source() {
    local src="$AETHER_REPO_DIR"

    if [ ! -f "$src/package.json" ]; then
        # No source repo to sync from. If a source tree is already deployed —
        # which is the case when `aether install --resume` re-runs the installer
        # from the installed CLI — keep it. Cloning over it would either fail or
        # silently replace the version that is running.
        if [ -f "$AETHER_INSTALL_DIR/src/package.json" ]; then
            info "Keeping the deployed source tree at $AETHER_INSTALL_DIR/src"
            return 0
        fi

        info "No local repo at ${src:-<unset>} — cloning from GitHub"
        mkdir -p "$(dirname "$AETHER_INSTALL_DIR/src")"
        git clone --depth 1 https://github.com/AFR-projection/Aether-OS.git "$AETHER_INSTALL_DIR/src"
        return
    fi

    info "Syncing application source from $src"
    mkdir -p "$AETHER_INSTALL_DIR/src"
    # `.git` is deliberately kept: `aether update` compares the installed
    # checkout against the upstream branch and fast-forwards it, and
    # `aether version` reads the commit from it. Copying the tree without it
    # would leave an install that can never be updated from Git.
    if command_exists rsync; then
        rsync -a --delete \
            --exclude node_modules --exclude dist \
            --exclude '*.tsbuildinfo' --exclude .env \
            "$src/" "$AETHER_INSTALL_DIR/src/"
    else
        # tar-copy fallback for images without rsync.
        (cd "$src" && tar cf - \
            --exclude=./node_modules --exclude=./*/dist \
            --exclude=./*/node_modules --exclude=./.env .) \
            | (cd "$AETHER_INSTALL_DIR/src" && tar xf -)
    fi
}

# The bundle is built by utils.sh's install_frontend_bundle, which `aether
# update` and `aether restore` also use — one implementation of "build the
# frontend", not three that drift.
build_frontend_bundle() {
    local static_dir="$AETHER_INSTALL_DIR/static"

    if [ -f "$static_dir/index.html" ] && [ "${AETHER_FORCE_BUILD:-}" != "true" ]; then
        info "Frontend bundle already present — skipping (AETHER_FORCE_BUILD=true to force)"
        return 0
    fi

    stage "Building frontend bundle"
    install_frontend_bundle \
        || fatal "The frontend bundle could not be built. See the build output above."
}

write_caddyfile() {
    local caddy_dir="$AETHER_INSTALL_DIR/caddy"
    mkdir -p "$caddy_dir"

    if [ -n "${AETHER_DOMAIN:-}" ] && [ "${AETHER_NO_HTTPS:-false}" != "true" ]; then
        # HTTPS mode: use main Caddyfile with ACME, HSTS, and email
        cp "${AETHER_INSTALL_DIR}/src/deploy/Caddyfile" "$caddy_dir/Caddyfile"
        info "Caddyfile installed (HTTPS domain mode)"
    else
        # HTTP mode: use HTTP-only template without HSTS or email requirement
        local site_address
        if [ -n "${AETHER_DOMAIN:-}" ]; then
            site_address="http://\${AETHER_DOMAIN}"
        else
            site_address=":80"
        fi

        # Use HTTP template and substitute site address
        sed "s|{\$AETHER_SITE_ADDRESS}|$site_address|" \
            "${AETHER_INSTALL_DIR}/src/deploy/Caddyfile.http" > "$caddy_dir/Caddyfile"

        if [ -n "${AETHER_DOMAIN:-}" ]; then
            info "Caddyfile installed (HTTP-only domain mode)"
        else
            info "Caddyfile installed (HTTP IP-only mode)"
        fi
    fi
}

install_compose_file() {
    # docker-compose.prod.yml is authored for a repo-root checkout: build context
    # `.`, with `packages/` and `pnpm-workspace.yaml` beside it, and the Caddyfile
    # under ./deploy. The installed layout keeps the checkout in ./src, the
    # Caddyfile in ./caddy, and the built bundle in ./static, so those three
    # paths are rewritten here instead of maintaining a second, drifting copy of
    # the file.
    #
    # Symlinking `packages/` into the install root would be the obvious
    # alternative and does not work: Docker refuses a build-context path that
    # resolves through a symlink pointing outside the context.
    sed \
        -e 's|^\( *\)context: \.$|\1context: ./src|' \
        -e 's|\( *- \)\./deploy/Caddyfile:|\1./caddy/Caddyfile:|' \
        -e 's|\( *- \)\./packages/frontend/dist:|\1./static:|' \
        "${AETHER_INSTALL_DIR}/src/docker-compose.prod.yml" \
        > "${AETHER_INSTALL_DIR}/docker-compose.yml"

    # A substitution that silently matched nothing would leave a compose file
    # that cannot build the backend or serve the frontend, so each one is
    # asserted rather than assumed.
    local generated="${AETHER_INSTALL_DIR}/docker-compose.yml"
    grep -q 'context: \./src' "$generated" \
        || fatal "Could not rewrite the backend build context in docker-compose.yml"
    grep -q -- '- \./caddy/Caddyfile:' "$generated" \
        || fatal "Could not rewrite the Caddyfile mount in docker-compose.yml"
    grep -q -- '- \./static:' "$generated" \
        || fatal "Could not rewrite the frontend bundle mount in docker-compose.yml"

    # Validates the YAML and the variable interpolation before anything is built
    # from it. `.env` is already written at this point, so this also proves the
    # required secrets are present.
    compose_cmd -f "$generated" config >/dev/null \
        || fatal "The generated docker-compose.yml is not usable (see the error above)"

    info "docker-compose.yml installed at $generated"
}

# The workspace and uploads directories are bind-mounted into the backend, which
# runs as uid/gid 1001. Docker creates a missing bind-mount source as root:root,
# so they are created here and owned by that uid — including each time an
# existing install is re-synced, since the backend cannot write otherwise.
prepare_data_dirs() {
    local app_uid="${AETHER_APP_UID:-1001}"
    local app_gid="${AETHER_APP_GID:-1001}"

    mkdir -p "${AETHER_INSTALL_DIR}/data/workspace" "${AETHER_INSTALL_DIR}/data/uploads"
    $SUDO chown -R "$app_uid:$app_gid" "${AETHER_INSTALL_DIR}/data"
    info "Data directories ready (owned by $app_uid:$app_gid)"
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
    prepare_data_dirs
    build_frontend_bundle
    start_services
}
