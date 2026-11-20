#!/bin/sh
# Lightning VM: install on a fresh server with one command. Gets the source with git, so the installation
# can update itself later (from the admin panel or `sh scripts/install.sh update`).
# Run again on a server that is already installed, it updates that installation the way `install.sh update`
# does (backup first, rollback on failure) and leaves its update channel as it is.
#
#   curl -fsSL https://lightningvm.app/install.sh | sudo sh -s -- [options] [-- install options]
#
# Options:
#   --repo URL        git repository (default: the one below; SSH URLs work with a deploy key)
#   --dir DIR         where the source goes (default /opt/lightning-vm)
#   --version vX.Y.Z  a released version (default: the latest stable release)
#   --branch NAME     a branch instead of releases; updates then follow it (channel "edge", test servers)
#   --token-file FILE read-only access token for a private repository, read from FILE (its first line), or
#                     GIT_TOKEN in the environment (export GIT_TOKEN; ... | sudo --preserve-env=GIT_TOKEN sh);
#                     kept in a root-only credential file so later updates can fetch too
#   --token TOKEN     the same on the command line. It works, but every local account can read it in the
#                     process list for as long as the installation runs: prefer the two ways above
# Everything after "--" goes to scripts/install.sh, for example: -- --domain panel.example.com --lang tr
set -eu

REPO=${LVM_REPO:-https://github.com/syildirim689/lightning-vm.git}
DIR=/opt/lightning-vm VERSION="" BRANCH="" TOKEN=${GIT_TOKEN:-} TOKEN_FILE="" cred=""
# Not handed on in the environment of git, apt or the installer started below.
unset GIT_TOKEN
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift; REPO=${1:-} ;;
    --dir) shift; DIR=${1:-} ;;
    --version) shift; VERSION=${1:-} ;;
    --branch) shift; BRANCH=${1:-} ;;
    --token) shift; TOKEN=${1:-} ;;
    --token-file) shift; TOKEN_FILE=${1:-} ;;
    --) shift; break ;;
    *) echo "unknown option: $1 (install options go after --)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%-5s %s\n' "$1" "$2"; }
die() { say FAIL "$1"; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -z "$VERSION" ] || echo "$VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "--version must look like v1.2.3"
[ -z "$BRANCH" ] || echo "$BRANCH" | grep -Eq '^[A-Za-z0-9._/-]{1,100}$' || die "invalid --branch"
[ -z "$VERSION" ] || [ -z "$BRANCH" ] || die "use --version or --branch, not both"

if ! command -v git >/dev/null; then
  say INFO "installing git"
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q git >/dev/null
  else die "install git first"; fi
fi

if [ -n "$TOKEN_FILE" ]; then
  [ -r "$TOKEN_FILE" ] || die "--token-file: cannot read $TOKEN_FILE"
  IFS= read -r TOKEN < "$TOKEN_FILE" || true
  [ -n "$TOKEN" ] || die "--token-file: $TOKEN_FILE is empty"
fi
git_() { git -c safe.directory="$DIR" "$@"; }
# A private repository: the token goes to a root-only credential store, never into the remote URL.
if [ -n "$TOKEN" ]; then
  cred=/root/.lightning-vm-git-credentials
  host=$(echo "$REPO" | sed -n 's#^https://\([^/]*\)/.*#\1#p')
  [ -n "$host" ] || die "--token works with https repository URLs"
  (umask 077; printf 'https://x-access-token:%s@%s\n' "$TOKEN" "$host" > "$cred")
  # From here on only the file knows it.
  TOKEN=""
fi
gitc() { if [ -n "$cred" ]; then git_ -c "credential.helper=store --file=$cred" "$@"; else git_ "$@"; fi; }

if [ -d "$DIR/.git" ]; then
  say INFO "updating the source in $DIR"
  gitc -C "$DIR" fetch --quiet --tags --force origin || die "git fetch failed (access to $REPO?)"
else
  [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR exists and is not a git checkout; choose another --dir"
  say INFO "downloading $REPO to $DIR"
  # No checkout here: the version to install is checked out below.
  gitc clone --quiet --no-checkout "$REPO" "$DIR" || die "git clone failed (private repository? use --token or an SSH URL with a deploy key)"
fi
[ -z "$cred" ] || git_ -C "$DIR" config credential.helper "store --file=$cred"

cd "$DIR"
if [ -f .env ]; then
  # Something is installed here already. Checking out another version under it and running `install` would
  # skip the backup, the migration check and the rollback, and would put a server that follows a branch back
  # on the stable channel, on older code than its database.
  if [ -s data/maintenance/history.jsonl ]; then
    # A finished installation (its first backup is in the history): `update` does this safely and follows the
    # channel this server already has. Of the install options only the language means anything to it.
    lang=""
    while [ $# -gt 0 ]; do if [ "$1" = --lang ] && [ $# -gt 1 ]; then lang=$2; fi; shift; done
    [ -z "$BRANCH" ] || say WARN "--branch is not applied to an existing installation; to follow a branch: sh scripts/install.sh auto-update on|off --channel edge --branch $BRANCH"
    say INFO "an installation exists in $DIR: updating it (backup first, rollback on failure; its update channel is kept)"
    set -- update
    [ -z "$VERSION" ] || set -- "$@" --to "$VERSION"
    [ -z "$lang" ] || set -- "$@" --lang "$lang"
    exec sh scripts/install.sh "$@"
  elif [ -z "$VERSION" ] && [ -z "$BRANCH" ] && git_ rev-parse -q --verify HEAD >/dev/null; then
    # An installation that was interrupted: it continues with the version it started with and the channel
    # already written to .env.
    say INFO "continuing the interrupted installation in $DIR ($(git_ describe --tags --always))"
    exec sh scripts/install.sh install "$@"
  fi
fi
if [ -n "$BRANCH" ]; then
  target="origin/$BRANCH"; extra="--channel edge --branch $BRANCH"
elif [ -n "$VERSION" ]; then
  target=$VERSION; extra="--channel stable"
else
  target=$(git_ -c versionsort.suffix=- tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  extra="--channel stable"
  if [ -z "$target" ]; then
    branch=$(git_ symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); branch=${branch:-main}
    say WARN "no released version yet; installing the $branch branch (updates follow it)"
    target="origin/$branch"; extra="--channel edge --branch $branch"
  fi
fi
git_ rev-parse -q --verify "$target^{commit}" >/dev/null || die "unknown version or branch: $target"
git_ -c advice.detachedHead=false checkout -q --detach "$target"
say OK "source at $(git_ describe --tags --always)"
# shellcheck disable=SC2086 # extra holds separate arguments on purpose
exec sh scripts/install.sh install $extra "$@"
