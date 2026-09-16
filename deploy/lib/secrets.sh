#!/usr/bin/env bash
# Aether Cloud OS — secret generation.
#
# Secret generation rules:
# - CSPRNG only: openssl rand, never $RANDOM or predictable values.
# - Each secret lives in its own file under $AETHER_SECRETS_DIR (dir 700,
#   files 600); the generated `.env` reads them back at install time.
# - Secrets are never echoed to stdout, never written to the install log,
#   and never reused across installations.
# - An existing secret file is NEVER regenerated: upgrades reuse it, because
#   a rotated ENCRYPTION_KEY would make existing ciphertext undecryptable.

generate_secret_alnum() {
    local length="${1:-32}"
    # Do not pipe into head: with pipefail enabled, the producer can receive
    # SIGPIPE and make an otherwise successful install fail intermittently.
    local value
    value=$(openssl rand -base64 256 | tr -dc 'a-zA-Z0-9')
    [ "${#value}" -ge "$length" ] || fatal "CSPRNG returned too few alphanumeric bytes"
    printf '%s' "${value:0:length}"
}

generate_secret_hex() {
    local bytes="${1:-32}"
    openssl rand -hex "$bytes"
}

generate_secret_base64() {
    local bytes="${1:-64}"
    openssl rand -base64 "$bytes" | tr -d '\n'
}

# ensure_secret <name> <generator-fn> — prints the secret, generating and
# persisting it only when the file does not exist yet.
ensure_secret() {
    local name="$1" generator="$2"
    shift 2
    local file="$AETHER_SECRETS_DIR/$name"

    if [ ! -d "$AETHER_SECRETS_DIR" ]; then
        mkdir -p "$AETHER_SECRETS_DIR"
        chmod 700 "$AETHER_SECRETS_DIR"
    fi

    if [ -s "$file" ]; then
        info "Reusing existing secret: $name" >&2
    else
        info "Generating new secret: $name" >&2
        umask 077
        "$generator" "$@" > "$file"
        chmod 600 "$file"
    fi

    cat "$file"
}

read_secret() {
    local name="$1"
    local file="$AETHER_SECRETS_DIR/$name"

    if [ ! -s "$file" ]; then
        fatal "Secret '$name' is missing at $file. Run the installer to generate it."
    fi
    cat "$file"
}

# Generates the full set the backend's config.ts demands, with the sizes from
# the contract: 32-char alphanumeric passwords, 512-bit JWT/session secrets,
# 256-bit hex encryption key.
generate_all_secrets() {
    require_command openssl

    SECRET_DB_PASSWORD=$(ensure_secret db_password generate_secret_alnum)
    SECRET_REDIS_PASSWORD=$(ensure_secret redis_password generate_secret_alnum)
    SECRET_JWT=$(ensure_secret jwt_secret generate_secret_base64)
    SECRET_ENCRYPTION_KEY=$(ensure_secret encryption_key generate_secret_hex)
    SECRET_SESSION=$(ensure_secret session_secret generate_secret_base64)
    SECRET_INSTANCE_ID=$(ensure_secret instance_id generate_secret_alnum 16)
    SECRET_BOOTSTRAP_TOKEN=$(ensure_secret bootstrap_token generate_secret_base64 32)

    export SECRET_DB_PASSWORD SECRET_REDIS_PASSWORD SECRET_JWT SECRET_ENCRYPTION_KEY SECRET_SESSION SECRET_INSTANCE_ID SECRET_BOOTSTRAP_TOKEN
}
