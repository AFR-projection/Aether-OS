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

    # SOURCE is confined to this one function, so this function owns its stage:
    # it opens it here and closes it in each branch below, because only here is
    # it known which of the three things actually happened — the tree was
    # cloned, it was synced, or a tree already deployed was kept. An orchestrator
    # marking the stage complete could only guess at that, and the guess would be
    # wrong exactly when it matters (a resumed install that kept its tree).
    ui_stage_begin_notify SOURCE "Fetching the source tree"

    if [ ! -f "$src/package.json" ]; then
        # No source repo to sync from. If a source tree is already deployed —
        # which is the case when `aether install --resume` re-runs the installer
        # from the installed CLI — keep it. Cloning over it would either fail or
        # silently replace the version that is running.
        if [ -f "$AETHER_INSTALL_DIR/src/package.json" ]; then
            info "Keeping the deployed source tree at $AETHER_INSTALL_DIR/src"
            ui_stage_done_notify SOURCE "kept the deployed source tree"
            return 0
        fi

        info "No local repo at ${src:-<unset>} — cloning from GitHub"
        ui_note SOURCE "Cloning the source tree from GitHub"
        mkdir -p "$(dirname "$AETHER_INSTALL_DIR/src")"
        git clone --depth 1 https://github.com/AFR-projection/Aether-OS.git "$AETHER_INSTALL_DIR/src"
        ui_stage_done_notify SOURCE "cloned from GitHub"
        return
    fi

    info "Syncing application source from $src"
    ui_note SOURCE "Syncing the source tree from $src"
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

    ui_stage_done_notify SOURCE "synced from $src"
}

# The bundle is built by utils.sh's install_frontend_bundle, which `aether
# update` and `aether restore` also use — one implementation of "build the
# frontend", not three that drift.
build_frontend_bundle() {
    local static_dir="$AETHER_INSTALL_DIR/static"

    if [ -f "$static_dir/index.html" ] && [ "${AETHER_FORCE_BUILD:-}" != "true" ]; then
        info "Frontend bundle already present — skipping (AETHER_FORCE_BUILD=true to force)"
        # SKIPPED, never SUCCESS: the build did not run. A stage that reports
        # success for work it skipped is the one claim this panel must not make,
        # and only this branch knows the build was not what produced the bundle.
        ui_stage_skipped_notify FRONTEND "bundle already present"
        return 0
    fi

    stage "Building frontend bundle"
    # ui_run is applied here, at the call site, not inside
    # install_frontend_bundle. That function is also called by `aether update`
    # and `aether restore`, and ui_run sends the child's stdout to a file — fine
    # for a build whose output nobody reads back, wrong for anything whose output
    # is captured. Keeping the wrapper here means the shared implementation is
    # untouched for its other callers.
    ui_run "Building the frontend bundle" install_frontend_bundle \
        || fatal "The frontend bundle could not be built. See the build output above."

    ui_stage_done_notify FRONTEND "bundle built"
}

write_caddyfile() {
    local caddy_dir="$AETHER_INSTALL_DIR/caddy"
    mkdir -p "$caddy_dir"

    # The CADDY stage is opened by deploy_application, not here, because the
    # stage spans two operations that live in different functions: writing this
    # file and the proxy actually answering. `aether update` calls this function
    # too (to regenerate the Caddyfile from the updated source), and a stage
    # opened here would be left RUNNING by that path, which never reaches the
    # container check that closes it.
    local mode="HTTP (IP only)"
    if [ -n "${AETHER_DOMAIN:-}" ]; then
        if [ "${AETHER_NO_HTTPS:-false}" = "true" ]; then
            mode="HTTP (${AETHER_DOMAIN})"
        else
            mode="HTTPS (${AETHER_DOMAIN})"
        fi
    fi
    ui_note CADDY "Writing the reverse-proxy configuration — $mode"

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

    install_preview_sites "$caddy_dir/Caddyfile"
}

# Adds one site block per preview port to the Caddyfile.
#
# Caddy has no loop, so the blocks are generated here. Without them a preview
# address would be served by no site at all, and Caddy would answer the TLS
# handshake with its own certificate and then 404 — which looks like the project
# being broken rather than the proxy not being told about it.
#
# The blocks deliberately differ from the desktop's:
#   - no X-Frame-Options and no frame-ancestors, because the desktop frames
#     these pages and the whole point is that the frame is allowed;
#   - no HSTS, because HSTS is not scoped to a port and the desktop's own block
#     already sets it for this host;
#   - no compression, because a dev server's hot reload and event streams are the
#     traffic here and they are not meaningfully compressible.
# `encode` is left off for the same reason the response is passed through in one
# piece: what arrives is what the project sent.
install_preview_sites() {
    local caddyfile="$1"

    if [ "${AETHER_PREVIEW_ENABLED:-true}" != "true" ]; then
        info "Port previews are disabled — no preview site blocks added"
        return 0
    fi

    if ! grep -q '^# AETHER_PREVIEW_SITES$' "$caddyfile"; then
        warn "The Caddyfile has no preview marker; preview addresses will not be served"
        return 0
    fi

    local start end port
    start="$AETHER_PREVIEW_PORT_START"
    end="$(preview_port_end)"

    # The site address for one preview port, per install mode.
    #
    # HTTPS mode names no scheme: Caddy terminates TLS and answers with the
    # certificate for the hostname, and a port is not part of a certificate's
    # name — so this is the same certificate the desktop already has, reused.
    # The other two modes are HTTP, where the scheme has to be spelled out
    # because Caddy reads a bare hostname as a request for HTTPS.
    local template
    if [ -n "${AETHER_DOMAIN:-}" ] && [ "${AETHER_NO_HTTPS:-false}" != "true" ]; then
        template='{$AETHER_DOMAIN}:PORT'
    elif [ -n "${AETHER_DOMAIN:-}" ]; then
        template='http://{$AETHER_DOMAIN}:PORT'
    else
        template=':PORT'
    fi

    local blocks
    blocks=$(mktemp)

    port="$start"
    while [ "$port" -le "$end" ]; do
        {
            printf '%s {\n' "${template//PORT/$port}"
            cat <<'BLOCK'
	header {
		# No X-Frame-Options here, and no frame-ancestors: the desktop frames
		# this address, and a refusal would leave the preview window empty.
		X-Content-Type-Options "nosniff"
		Referrer-Policy "same-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		-Server
	}

	handle {
		reverse_proxy backend:3000 {
			# A preview carries a hot-reload socket for as long as the project
			# runs, and a dev server's first response compiles the project.
			transport http {
				dial_timeout 10s
				response_header_timeout 0s
				expect_continue_timeout 0s
			}
		}
	}

	# No `encode` and no HSTS: compression would rewrite a stream whose framing
	# is the project's business, and HSTS is not scoped to a port — the desktop's
	# own block already sets it for this host.
	log {
		output stdout
		format json
	}
}

BLOCK
        } >> "$blocks"
        port=$((port + 1))
    done

    # The marker line is kept and the blocks are inserted after it, so the file
    # reads as a template that was filled in rather than one that was rewritten.
    local assembled
    assembled=$(mktemp)
    sed "/^# AETHER_PREVIEW_SITES\$/r $blocks" "$caddyfile" > "$assembled"
    rm -f "$blocks"
    mv "$assembled" "$caddyfile"

    # A Caddyfile with preview addresses and no upstream would take the whole
    # proxy down on reload, so the substitution is asserted rather than assumed.
    grep -q 'backend:3000' "$caddyfile" \
        || fatal "The generated Caddyfile lost its backend upstream"
    grep -q "${template//PORT/$start}" "$caddyfile" \
        || fatal "Could not write the preview site blocks into the Caddyfile"

    info "Preview addresses: $start-$end"
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
    #
    # The preview port range is rewritten the same way. Compose cannot expand a
    # loop, so the shipped file carries the default range and the installer
    # writes the configured one over it — matching the Caddyfile blocks and the
    # firewall rule that are generated from the same three values.
    # The compose manifest has no stage of its own in the fixed stage vocabulary,
    # and it is written while CADDY's stage is open. Rather than attach it to a
    # stage that does not describe it, it is published as the current operation —
    # the panel then names what is actually running rather than leaving a silent
    # gap where a multi-second file render and a `compose config` validation sit.
    ui_note CADDY "Rendering docker-compose.yml for this instance"

    local preview_range
    preview_range="$(preview_port_range)"

    sed \
        -e 's|^\( *\)context: \.$|\1context: ./src|' \
        -e 's|\( *- \)\./deploy/Caddyfile:|\1./caddy/Caddyfile:|' \
        -e 's|\( *- \)\./packages/frontend/dist:|\1./static:|' \
        -e "s|'8443-8452:8443-8452'|'${preview_range}:${preview_range}'|" \
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
    grep -q "'${preview_range}:${preview_range}'" "$generated" \
        || fatal "Could not rewrite the preview port range in docker-compose.yml"

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

    # STORAGE is confined to this function, so this function owns its stage.
    ui_stage_begin_notify STORAGE "Storage layout"
    ui_note STORAGE "Creating the workspace and uploads directories"
    mkdir -p "${AETHER_INSTALL_DIR}/data/workspace" "${AETHER_INSTALL_DIR}/data/uploads"
    $SUDO chown -R "$app_uid:$app_gid" "${AETHER_INSTALL_DIR}/data"
    info "Data directories ready (owned by $app_uid:$app_gid)"
    ui_stage_done_notify STORAGE "owned by $app_uid:$app_gid"
}

# The health Docker itself reports for one compose service: "healthy",
# "starting", "unhealthy", "restarting", or the container's plain state
# ("running", "exited") for a service with no healthcheck. Empty when there is no
# container for it at all.
#
# Read from Docker rather than inferred from the exit status of `compose up`.
# That status says the command asked Docker to start the service; the only thing
# that says the service came up is Docker's own report about the container. The
# two are not the same, which is how an install can print "services started" and
# then fail a minute later on a database that never became ready.
#
# `ps -a` rather than `ps`: a container that has already exited is exactly the
# case worth seeing, and the default listing would hide it until the wait timed
# out. Must be called from the compose project directory.
service_health() {
    local service="$1" container
    container=$(compose_cmd ps -a -q "$service" 2>/dev/null || true)
    [ -n "$container" ] || return 0
    docker_cmd inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$container" 2>/dev/null || true
}

# Waits for one service to report healthy, bounded, and closes its stage on the
# answer.
#
# The bounded probe is a real denominator: a fixed number of checks, each of
# which either passed or did not, so the bar is honest rather than decorative.
# It is cleared as the stage closes so a finished count is not left sitting over
# the next operation.
#
# A service Docker calls unhealthy, exited or dead has stopped: the wait ends
# there rather than spending the remaining minutes on a container that is not
# coming back. The caller decides what that means — this function deliberately
# does not mark the stage FAILED itself, because the stage it opened is still the
# current stage and the caller's fatal() is what records the failure with the
# real reason and exit code.
wait_for_service() {
    local service="$1" stage_id="$2" label="$3"
    local total="${4:-60}"
    local attempt=0 health=""

    ui_stage_begin_notify "$stage_id" "$label"
    while [ "$attempt" -lt "$total" ]; do
        attempt=$((attempt + 1))
        ui_progress "$stage_id" "$attempt" "$total" "checks"
        health="$(service_health "$service")"
        case "$health" in
            healthy | running)
                ui_progress_clear "$stage_id"
                ui_stage_done_notify "$stage_id" "$health"
                return 0
                ;;
            unhealthy | exited | dead)
                break
                ;;
        esac
        sleep 3
    done

    ui_progress_clear "$stage_id"
    error "Service $service is not healthy (Docker reports: ${health:-no container})"
    return 1
}

start_services() {
    stage "Starting services"
    cd "$AETHER_INSTALL_DIR"

    # BACKEND opens here and covers the whole of this function: the image build,
    # the start, and the backend becoming healthy. Only the two other stages it
    # passes through — the database and the cache, which compose brings up before
    # the backend because the backend depends on both being healthy — are opened
    # and closed beneath it.
    ui_stage_begin_notify BACKEND "Backend"

    # Non-fatal on purpose, and it was `|| true` before this layer existed: a host
    # that already has the images, or cannot reach the registry but can build from
    # cache, installs fine. It is a note rather than a stage of its own because a
    # stage cannot report SUCCESS for a command that is allowed to fail, and
    # cannot report FAILED for one the install continues past.
    ui_note BACKEND "Pulling base images"
    compose_cmd pull --quiet 2>/dev/null || true

    # Run through ui_run so the panel stays live through the minutes this takes:
    # the child's output goes to a file, the parent redraws, and the exit status
    # comes back unchanged. A failure is fatal exactly as it was before.
    ui_run "Building the backend image" compose_cmd build backend \
        || fatal "Could not build the backend image. See the build output above."

    # One `up`, not four. Compose starts postgres and redis first, waits on each
    # `depends_on: service_healthy`, then starts the backend, then Caddy. That
    # ordering is compose's own; re-implementing it as four separate `up` calls
    # would run the same orchestration four times and would be a different
    # deployment from the one this installer has always performed.
    ui_run "Starting containers" compose_cmd up -d \
        || fatal "The stack did not start. Check: aether logs"

    # What the `up` above asked for is then read back service by service, in the
    # order compose brought them up. Each stage is closed on Docker's own report
    # about its container — never on the exit status of the command that created
    # it. A service that did not come up stops the install here, where the reason
    # is still legible, instead of surfacing later as a backend that answers while
    # its database never started.
    wait_for_service postgres DATABASE "PostgreSQL" \
        || fatal "PostgreSQL did not become healthy. Check: aether logs postgres"
    wait_for_service redis REDIS "Redis" \
        || fatal "Redis did not become healthy. Check: aether logs redis"

    ui_stage_done_notify BACKEND "running and healthy"

    # CADDY was opened by deploy_application, before the Caddyfile was written,
    # and is closed here — the stage is not complete until the proxy is up.
    wait_for_service caddy CADDY "Reverse proxy and TLS" \
        || fatal "Caddy did not become healthy. Check: aether logs caddy"

    cd - >/dev/null
}

# The deployment sequence. The calls are in the order this installer has always
# made them; the UI layer sequences nothing.
#
# Stage ownership, stated once so it stays consistent across the files:
#   * a stage confined to a single function is opened and closed by that function
#     — SOURCE in sync_source, STORAGE in prepare_data_dirs, FRONTEND in
#     build_frontend_bundle;
#   * a stage that spans two functions is opened here and closed by whichever
#     call proves it — CADDY, closed in start_services once the proxy answers.
deploy_application() {
    sync_source

    # Opened before the file is written, closed once the caddy container is
    # healthy. Neither half alone is "reverse proxy and TLS": a written Caddyfile
    # with no proxy serving it, or a proxy serving a file that was never written,
    # would both be a stage reported SUCCESS for something that did not happen.
    ui_stage_begin_notify CADDY "Reverse proxy and TLS"
    write_caddyfile
    install_compose_file

    prepare_data_dirs
    build_frontend_bundle
    start_services
}
