#!/usr/bin/env bash
# Aether Cloud OS — update path harness.
#
# Exercises the part of `aether update` that decides where source comes from,
# without a host: a throwaway bare repository stands in for GitHub, and an
# install directory whose src/ has no `.git` stands in for a deployment that was
# installed from a downloaded tarball.
#
# It covers the state that made `aether update` a no-op on a live instance:
# src/ held the files but no history, so there was no origin to fetch from, and
# the update rebuilt whatever was already there while reporting success.
#
# Needs only bash and git. Runs anywhere, including Windows and CI:
#
#   bash deploy/tests/update-adoption.sh
#
# Exits 0 when every check passes, 1 when one fails, 77 when the environment
# cannot run it at all. It never reports a pass for a check it did not run.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  [ ok ] %s\n' "$1"; }
fail() {
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s\n' "$1"
}
check() {
    if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (expected '$3', got '$2')"; fi
}
yesno() { if [ "$1" = true ]; then printf 'yes'; else printf 'no'; fi; }
section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

blocked() {
    printf 'BLOCKED_BY_ENVIRONMENT: %s\n' "$1"
    printf 'No checks were executed.\n'
    exit 77
}

command -v git >/dev/null 2>&1 || blocked "git is not installed"

# Committing needs an identity. Set one only for this repository, so a machine
# with no global git identity still runs the harness and nothing else changes.
export GIT_AUTHOR_NAME="aether-harness"
export GIT_AUTHOR_EMAIL="harness@example.invalid"
export GIT_COMMITTER_NAME="aether-harness"
export GIT_COMMITTER_EMAIL="harness@example.invalid"

# --- a repository to adopt from --------------------------------------------
ORIGIN="$WORK/origin.git"
SEED="$WORK/seed"

git init --quiet --bare --initial-branch=main "$ORIGIN" 2>/dev/null \
    || blocked "git is too old for --initial-branch (2.28 or newer is required)"
git init --quiet --initial-branch=main "$SEED"

(
    cd "$SEED" || exit 1
    # The two files that identify this repository — the same two the installer
    # and the adoption both look for.
    mkdir -p deploy/lib deploy/scripts
    printf '{"name":"aether-cloud-os"}\n' > package.json
    printf '#!/usr/bin/env bash\n' > deploy/lib/install.sh
    printf 'v1\n' > VERSION
    git add -A
    git commit --quiet -m "v1"
    git remote add origin "$ORIGIN"
    git push --quiet origin main
) || blocked "could not build the test repository"

SEED_SHA="$(git -C "$SEED" rev-parse HEAD)"
SEED_SHORT="$(git -C "$SEED" rev-parse --short HEAD)"

# --- an install whose src is not a checkout --------------------------------
INSTALL="$WORK/install"
mkdir -p "$INSTALL/src/deploy/lib" "$INSTALL/src/deploy/scripts"
cp "$SEED/package.json" "$INSTALL/src/package.json"
cp "$SEED/deploy/lib/install.sh" "$INSTALL/src/deploy/lib/install.sh"
printf 'v1\n' > "$INSTALL/src/VERSION"

# --- drive update.sh's functions -------------------------------------------
export AETHER_INSTALL_DIR="$INSTALL"
export AETHER_REPO_URL="$ORIGIN"
unset AETHER_REPO_DIR

# update.sh parses "$@" while it is being sourced, so the positional parameters
# have to be empty first or it reads this script's arguments as update flags.
set --
# shellcheck source=/dev/null
source "$REPO_DIR/deploy/scripts/update.sh"

section "A tree with no Git history"
check "src begins without a checkout" "$(yesno "$(is_git_checkout && echo true || echo false)")" "no"

if adopt_git_checkout main >/dev/null 2>&1; then
    ok "adopt_git_checkout succeeds"
else
    fail "adopt_git_checkout succeeds"
fi

check "src is now a checkout" "$(yesno "$(is_git_checkout && echo true || echo false)")" "yes"
check "revision matches origin/main" "$(current_revision)" "$SEED_SHA"
check "short revision matches" "$(current_revision_short)" "$SEED_SHORT"
check "branch is the updated branch" "$(current_branch)" "main"
check "the adopted tree carries the upstream files" "$(cat "$INSTALL/src/VERSION")" "v1"
check "the adopted tree has a working origin" \
    "$(git -C "$INSTALL/src" ls-remote origin refs/heads/main | cut -f1)" "$SEED_SHA"
check "the clean-tree guard is satisfied" \
    "$(git -C "$INSTALL/src" status --porcelain --untracked-files=no | wc -l | tr -d ' ')" "0"
check "no staging directory is left behind" \
    "$(yesno "$([ -d "$INSTALL/src.adopting" ] && echo true || echo false)")" "no"

section "Rollback of a failed adoption"
check "the replaced tree is kept until the update succeeds" \
    "$(yesno "$([ -d "$INSTALL/src.pre-git" ] && echo true || echo false)")" "yes"
check "ADOPTED_PREVIOUS_SRC names it" "$ADOPTED_PREVIOUS_SRC" "$INSTALL/src.pre-git"

# roll_back reverted the *revision* before adoption existed, which a tree with
# no history has none of — so this path is what stops a failed first update
# from leaving an instance with no working source at all.
roll_back "local-copy" "local-copy" "" >/dev/null 2>&1
check "the tree that had no checkout is back" \
    "$(yesno "$(is_git_checkout && echo true || echo false)")" "no"
check "its files are back" "$(cat "$INSTALL/src/VERSION")" "v1"
check "nothing is left staged for a rollback" "$ADOPTED_PREVIOUS_SRC" ""
check "the replaced tree is no longer kept" \
    "$(yesno "$([ -d "$INSTALL/src.pre-git" ] && echo true || echo false)")" "no"

section "A clone that is not this repository"
adopt_git_checkout main >/dev/null 2>&1
mkdir -p "$WORK/empty"
git init --quiet --bare "$WORK/empty/not-aether.git"
if (AETHER_REPO_URL="$WORK/empty/not-aether.git" adopt_git_checkout main) >/dev/null 2>&1; then
    fail "a clone without the repository files is refused"
else
    ok "a clone without the repository files is refused"
fi
check "the running source tree was not touched by the refusal" \
    "$(current_revision_short)" "$SEED_SHORT"
check "no staging directory survives the refusal" \
    "$(yesno "$([ -d "$INSTALL/src.adopting" ] && echo true || echo false)")" "no"

section "Syncing from a local checkout"
# This is the path that used to strip `.git` — the one that turns an updatable
# install into one that can never update again.
INSTALL2="$WORK/install2"
mkdir -p "$INSTALL2/src"
AETHER_INSTALL_DIR="$INSTALL2"
AETHER_SRC_DIR="$INSTALL2/src"
AETHER_REPO_DIR="$SEED"

if sync_from_repo_dir >/dev/null 2>&1; then
    ok "sync_from_repo_dir succeeds"
else
    fail "sync_from_repo_dir succeeds"
fi
check "the synced tree keeps .git" \
    "$(yesno "$([ -d "$AETHER_SRC_DIR/.git" ] && echo true || echo false)")" "yes"
check "the synced tree is on origin/main" "$(current_revision_short)" "$SEED_SHORT"
check "is_repo_dir refuses the install directory itself" \
    "$(yesno "$(is_repo_dir "$INSTALL2" && echo true || echo false)")" "no"
check "is_repo_dir refuses an empty path" \
    "$(yesno "$(is_repo_dir "" && echo true || echo false)")" "no"

section "--check reporting"
check "the remote branch is read without a local repository" \
    "$(remote_branch_revision main)" "$SEED_SHA"
check "a branch that does not exist is reported as unreachable" \
    "$(remote_branch_revision nope >/dev/null 2>&1 && echo reachable || echo unreachable)" "unreachable"

printf '\n\033[1m== Summary\033[0m\n'
printf '  %d checks, %d failed\n\n' "$((PASS + FAIL))" "$FAIL"
[ "$FAIL" -eq 0 ]
