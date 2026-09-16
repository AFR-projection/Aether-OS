#!/usr/bin/env bash
# Aether Cloud OS — one-command installer.
#
# Target usage:
#   curl -fsSL https://<install-domain>/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/AFR-projection/Aether-OS/main/install.sh | bash
#
# When run from a repo checkout the libraries live in ./deploy/lib. When
# packaged for remote install they are copied next to this file. We detect
# which layout we are in by looking for deploy/lib/install.sh relative to
# this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/deploy/lib/install.sh" ]; then
    # Repo checkout: source from deploy/lib.
    exec "$SCRIPT_DIR/deploy/lib/install.sh" "$@"
fi

# Piped/released layout: fetch the official source tree over HTTPS. The root
# entry point is intentionally self-contained so `curl | bash` works even
# though a pipe cannot provide the rest of the repository on stdin.
if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' 'Aether installer requires git when run outside a repository checkout.' >&2
    exit 1
fi

INSTALL_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-installer.XXXXXX")"
cleanup() { rm -rf "$INSTALL_SOURCE_DIR"; }
trap cleanup EXIT INT TERM

printf '%s\n' 'Aether installer: downloading the official source tree over HTTPS…' >&2
git clone --depth 1 --quiet https://github.com/AFR-projection/Aether-OS.git "$INSTALL_SOURCE_DIR/repo"

if [ ! -f "$INSTALL_SOURCE_DIR/repo/deploy/lib/install.sh" ]; then
    printf '%s\n' 'Aether installer: downloaded source is missing deploy/lib/install.sh.' >&2
    exit 1
fi

export AETHER_REPO_DIR="$INSTALL_SOURCE_DIR/repo"
exec "$INSTALL_SOURCE_DIR/repo/deploy/lib/install.sh" "$@"
