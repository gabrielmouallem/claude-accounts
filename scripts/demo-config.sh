#!/usr/bin/env bash
# Builds an obviously fake demo config in a throwaway HOME (for screenshots only).
set -euo pipefail
D=${1:-/tmp/ca-demo}; rm -rf "$D"; mkdir -p "$D/home/code"
export HOME="$D/home" CA_CONFIG="$D/home/.config/claude-accounts/config.json"
CA="python3 $(dirname "$0")/../cli/ca"
for r in acme-api acme-web design-system side-project weekend-ml; do mkdir -p "$HOME/code/$r"; git init -q "$HOME/code/$r"; done
$CA add-account work >/dev/null; $CA add-account personal >/dev/null; $CA add-account client-x >/dev/null
$CA bind "$HOME/code/acme-api" work >/dev/null; $CA bind "$HOME/code/acme-web" work --mode docker >/dev/null
$CA bind "$HOME/code/design-system" client-x --mode desktop >/dev/null
$CA bind "$HOME/code/side-project" personal >/dev/null; $CA bind "$HOME/code/weekend-ml" personal --mode docker >/dev/null
echo FAKE > "$HOME/.config/claude-accounts/accounts/work/claude/.credentials.json"   # dummy file -> "Signed in"
echo FAKE > "$HOME/.config/claude-accounts/accounts/personal/docker-claude/.credentials.json"
echo "$CA_CONFIG"
