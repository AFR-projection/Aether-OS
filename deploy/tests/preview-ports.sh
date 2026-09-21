#!/usr/bin/env bash
# Aether Cloud OS — preview-port single-source-of-truth checks.
#
# The preview port range once lived, as a number, in four places that could not
# read each other: the backend config default, the installer's shell defaults,
# the docker-compose published mapping, and the firewall rule. P0 #4 collapsed
# that to one source — AETHER_PREVIEW_PORT_START/COUNT — from which a single
# derived value, AETHER_PREVIEW_PORT_RANGE, is computed once and consumed
# everywhere. This test fails if that collapse is ever undone: if the compose
# file grows a hardcoded range again, if the fallback default drifts from the
# START/COUNT defaults, or if the derivation stops being consistent.
#
# It needs only bash and the repo; it spawns nothing and touches no host state.
#
# Exit 0 when every check passes, 1 when one fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UTILS="$REPO_ROOT/deploy/lib/utils.sh"
CONFIGURE="$REPO_ROOT/deploy/lib/configure.sh"
FINALIZE="$REPO_ROOT/deploy/lib/finalize.sh"
COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
BACKEND_CONFIG="$REPO_ROOT/packages/backend/src/config.ts"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# utils.sh calls info/warn/fatal (defined in core.sh at install time). Stub them
# so the helpers can be sourced in isolation; fatal must be non-fatal here so a
# bad-input path returns rather than killing the test harness.
info() { :; }
warn() { :; }
fatal() { printf 'fatal: %s\n' "$*" >&2; return 1; }

# shellcheck source=/dev/null
. "$UTILS"

section "Derivation from START/COUNT"

# Defaults.
range_default="$(preview_port_range)"
end_default="$(preview_port_end)"
if [ "$range_default" = "8443-8452" ]; then
    ok "default range derives to 8443-8452"
else
    fail "default range is '$range_default', expected 8443-8452"
fi
if [ "$end_default" = "8452" ]; then
    ok "default end port derives to 8452"
else
    fail "default end port is '$end_default', expected 8452"
fi

# A custom range, computed in a subshell so the exported values take effect
# before utils.sh applies its defaults.
custom="$(
    export AETHER_PREVIEW_PORT_START=9000 AETHER_PREVIEW_PORT_COUNT=5
    info() { :; }; warn() { :; }; fatal() { return 1; }
    . "$UTILS"
    preview_port_range
)"
if [ "$custom" = "9000-9004" ]; then
    ok "a custom START=9000 COUNT=5 derives to 9000-9004"
else
    fail "custom range is '$custom', expected 9000-9004"
fi

section "docker-compose reads the derived value, with no hardcoded range"

# The published mapping must interpolate the env var…
if grep -Eq "AETHER_PREVIEW_PORT_RANGE.*:.*AETHER_PREVIEW_PORT_RANGE" "$COMPOSE"; then
    ok "the preview mapping uses \${AETHER_PREVIEW_PORT_RANGE}"
else
    fail "the preview mapping does not interpolate AETHER_PREVIEW_PORT_RANGE"
fi

# …and must NOT carry the old literal published mapping.
if grep -Eq "^\s*-\s*'8443-8452:8443-8452'" "$COMPOSE"; then
    fail "docker-compose.prod.yml still has a hardcoded '8443-8452:8443-8452' mapping"
else
    ok "no hardcoded 8443-8452:8443-8452 mapping remains in the compose file"
fi

section "The compose fallback default cannot drift from START/COUNT"

# Extract the `:-<default>` fallback from the mapping and assert it equals the
# range the default START/COUNT derive to. If someone changes the config
# defaults but not the fallback (or vice versa), this fails.
fallback="$(grep -oE '\$\{AETHER_PREVIEW_PORT_RANGE:-[0-9]+-[0-9]+\}' "$COMPOSE" | head -n1 | sed -E 's/.*:-([0-9]+-[0-9]+)\}/\1/')"
if [ -n "$fallback" ] && [ "$fallback" = "$range_default" ]; then
    ok "compose fallback ($fallback) equals the derived default ($range_default)"
else
    fail "compose fallback ('$fallback') does not equal the derived default ('$range_default')"
fi

section "The other consumers agree"

# configure.sh writes the derived value into .env.
if grep -q 'AETHER_PREVIEW_PORT_RANGE=${preview_range}' "$CONFIGURE"; then
    ok "configure.sh writes AETHER_PREVIEW_PORT_RANGE from the derived value"
else
    fail "configure.sh does not write a derived AETHER_PREVIEW_PORT_RANGE"
fi

# The backend config defaults match the shell defaults, so a build with no .env
# still agrees with the compose fallback.
if grep -q 'AETHER_PREVIEW_PORT_START:.*default(8443)' "$BACKEND_CONFIG" &&
    grep -q 'AETHER_PREVIEW_PORT_COUNT:.*default(10)' "$BACKEND_CONFIG"; then
    ok "backend config defaults (8443/10) match the shell defaults"
else
    fail "backend config defaults do not match START=8443 COUNT=10"
fi

# The firewall opens the same range, in ufw's colon form.
fw="${AETHER_PREVIEW_PORT_START:-8443}:$(preview_port_end)"
if [ "$fw" = "8443:8452" ] && grep -q 'preview_port_end' "$FINALIZE"; then
    ok "the firewall rule derives from the same helper (8443:8452)"
else
    fail "the firewall range derivation is inconsistent (got '$fw')"
fi

printf '\n\033[1m== Summary\033[0m\n'
printf '  %d checks, %d failed\n\n' "$((PASS + FAIL))" "$FAIL"
[ "$FAIL" -eq 0 ]
