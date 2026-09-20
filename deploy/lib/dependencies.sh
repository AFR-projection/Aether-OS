#!/usr/bin/env bash
# Aether Cloud OS — dependency management.
#
# Contract §4.1 limits the package list to: curl, wget, git, openssl,
# ca-certificates (plus Docker when it is missing). Installing anything
# beyond that requires consent, so this file deliberately stays small.
# Contract §11.1: an existing Docker is respected, never reinstalled or
# downgraded.

# Base tooling every install needs.
BASE_PACKAGES=(curl wget git openssl ca-certificates)

# Installer prerequisites some minimal VPS images lack.
DOCKER_HELPER_PACKAGES=(gnupg lsb-release dnsutils)

# Every apt call goes through apt_get (utils.sh) so it waits for the dpkg lock
# instead of failing on a fresh VPS whose unattended-upgrades still holds it.
_apt_install() {
    apt_get install -y --no-install-recommends "$@"
}

install_base_packages() {
    stage "Installing base packages"

    # The one real denominator in this stage: a fixed, known set probed one at a
    # time. The total is computed from the arrays so it stays honest if either
    # list changes. This scan is fast; the bar is cleared the moment it ends so a
    # stale "8/8" does not sit over the install that follows, which has no
    # per-package signal and must read as indeterminate.
    local total=$(( ${#BASE_PACKAGES[@]} + ${#DOCKER_HELPER_PACKAGES[@]} ))
    local missing=()
    local wanted pkg scanned=0
    ui_note DEPENDENCIES "Checking which packages are present"
    for wanted in "${BASE_PACKAGES[@]}" "${DOCKER_HELPER_PACKAGES[@]}"; do
        pkg="$wanted"
        scanned=$((scanned + 1))
        ui_progress DEPENDENCIES "$scanned" "$total" packages
        if ! dpkg -s "$pkg" >/dev/null 2>&1; then
            missing+=("$pkg")
        fi
    done
    ui_progress_clear DEPENDENCIES

    if [ ${#missing[@]} -eq 0 ]; then
        info "All required base packages are already installed"
        ui_note DEPENDENCIES "All base packages already present"
        return
    fi

    info "Installing: ${missing[*]}"
    # ui_run sets the stage message from its own label, so no ui_note precedes it.
    ui_run "Refreshing package lists" apt_get update -qq
    ui_run "Installing ${#missing[@]} base package(s)" _apt_install "${missing[@]}"
}

docker_version_ge() {
    # compare `printf '%s\n' | sort -V` numerically-aware
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

# Publishes the Docker and Compose versions the panel's runtime line shows, read
# back from the commands themselves once the step above has succeeded — so the
# line reports the engine that is installed, not the one that was asked for.
#
# A version that cannot be read is not published at all. "Docker unknown" would
# be noise on a line whose whole purpose is to be trusted, and a substituted
# string would be worse than either. The parse mirrors the one check_docker
# already uses for the same output (`awk '{print $3}'`, comma stripped), so both
# places agree about what "the Docker version" is.
publish_runtime_facts() {
    local version

    if version=$(docker --version 2>/dev/null); then
        ui_fact_set docker "Docker $(printf '%s' "$version" | awk '{print $3}' | tr -d ',')" runtime
    fi
    if version=$(docker compose version 2>/dev/null); then
        # "Docker Compose version v2.29.7" -> "Compose v2.29.7"
        ui_fact_set compose "Compose ${version##* }" runtime
    fi
}

check_docker() {
    if ! command_exists docker; then
        return 1
    fi

    if ! docker info >/dev/null 2>&1; then
        warn "Docker is installed but the daemon is not running. Attempting to start it."
        $SUDO systemctl start docker || true
        docker info >/dev/null 2>&1 || return 1
    fi

    # Compose v2 is required by docker-compose.prod.yml.
    if docker compose version >/dev/null 2>&1; then
        info "Docker $(docker --version | awk '{print $3}' | tr -d ',') with Compose v2 detected — reusing it"
        # A note under DEPENDENCIES, not a skipped stage: there is no DOCKER
        # stage id, and base packages really were installed in this same run, so
        # marking the whole stage skipped would be false.
        ui_note DEPENDENCIES "Existing Docker with Compose v2 detected — reusing it"
        return 0
    fi

    warn "Docker exists but 'docker compose' (v2 plugin) is missing; installing the plugin."
    ui_run "Installing the Docker Compose v2 plugin" _apt_install docker-compose-plugin || return 1
    docker compose version >/dev/null 2>&1
}

install_docker() {
    stage "Installing Docker Engine"

    # Official Docker apt repository (contract §14.1: HTTPS + signed by Docker's key).
    # The key fetch and the repo write are shell pipelines; ui_run runs a single
    # command via "$@" and cannot host a pipeline, so these stay as they are with
    # only a note describing the operation.
    ui_note DEPENDENCIES "Adding Docker's package signing key"
    $SUDO install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg

    local codename
    codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
    if [ -z "$codename" ]; then
        codename=$(lsb_release -cs 2>/dev/null || true)
    fi
    [ -n "$codename" ] || fatal "Could not determine the Ubuntu codename for the Docker repository."

    ui_note DEPENDENCIES "Registering the Docker apt repository (${codename})"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

    ui_run "Refreshing package lists (Docker repository)" apt_get update -qq
    ui_run "Installing Docker Engine and Compose v2" \
        _apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    ui_note DEPENDENCIES "Enabling and starting the Docker service"
    $SUDO systemctl enable docker
    $SUDO systemctl start docker

    docker info >/dev/null 2>&1 || fatal "Docker was installed but the daemon is not responding."
    info "Docker installed: $(docker --version)"
}

# Adds the invoking user to the docker group so the compose commands run
# without sudo afterwards. Root installs skip this.
configure_docker_group() {
    local target_user="${SUDO_USER:-}"
    if [ -z "$target_user" ] || [ "$target_user" = "root" ]; then
        return
    fi

    if id -nG "$target_user" 2>/dev/null | grep -qw docker; then
        info "User $target_user is already in the docker group"
    else
        info "Adding $target_user to the docker group (re-login required for it to apply)"
        $SUDO usermod -aG docker "$target_user"
    fi
}

install_dependencies() {
    # Begin first, before any sub-call: this sets UI_CURRENT_STAGE=DEPENDENCIES,
    # which ui_run reads to attach its live output to this stage. A begin placed
    # any later would leave the base-package install with no stage to draw into.
    ui_stage_begin_notify DEPENDENCIES "Installing dependencies"

    # Clear any boot-time apt job holding the lock before the first install of
    # the run, so the very first apt-get does not have to wait it out. This can
    # block for minutes on a fresh VPS (cloud-init) with no output, so it gets an
    # explicit note rather than relying on a command tail.
    ui_note DEPENDENCIES "Waiting for background apt jobs to release the package lock"
    aether_apt_prepare
    install_base_packages
    if ! check_docker; then
        confirm "Docker (Engine + Compose v2) must be installed. Install it now?" || fatal "Cannot continue without Docker."
        install_docker
    fi
    publish_runtime_facts
    configure_docker_group
    ui_stage_done_notify DEPENDENCIES
}
