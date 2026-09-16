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

_apt_install() {
    $SUDO apt-get install -y --no-install-recommends "$@"
}

install_base_packages() {
    stage "Installing base packages"

    local missing=()
    local wanted pkg
    for wanted in "${BASE_PACKAGES[@]}" "${DOCKER_HELPER_PACKAGES[@]}"; do
        pkg="$wanted"
        if ! dpkg -s "$pkg" >/dev/null 2>&1; then
            missing+=("$pkg")
        fi
    done

    if [ ${#missing[@]} -eq 0 ]; then
        info "All required base packages are already installed"
        return
    fi

    info "Installing: ${missing[*]}"
    $SUDO apt-get update -qq
    _apt_install "${missing[@]}"
}

docker_version_ge() {
    # compare `printf '%s\n' | sort -V` numerically-aware
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
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
        return 0
    fi

    warn "Docker exists but 'docker compose' (v2 plugin) is missing; installing the plugin."
    _apt_install docker-compose-plugin || return 1
    docker compose version >/dev/null 2>&1
}

install_docker() {
    stage "Installing Docker Engine"

    # Official Docker apt repository (contract §14.1: HTTPS + signed by Docker's key).
    $SUDO install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg

    local codename
    codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
    if [ -z "$codename" ]; then
        codename=$(lsb_release -cs 2>/dev/null || true)
    fi
    [ -n "$codename" ] || fatal "Could not determine the Ubuntu codename for the Docker repository."

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

    $SUDO apt-get update -qq
    _apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

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
    install_base_packages
    if ! check_docker; then
        confirm "Docker (Engine + Compose v2) must be installed. Install it now?" || fatal "Cannot continue without Docker."
        install_docker
    fi
    configure_docker_group
}
