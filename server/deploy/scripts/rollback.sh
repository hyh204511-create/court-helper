#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version>" >&2
  exit 2
fi

TARGET="/opt/court-helper/releases/$1"
test -d "$TARGET" || { echo "Release not found: $TARGET" >&2; exit 2; }
exec /opt/court-helper/current/server/deploy/scripts/upgrade.sh "$TARGET"
