#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /opt/court-helper/releases/<version>" >&2
  exit 2
fi

TARGET="$(realpath "$1")"
case "$TARGET" in /opt/court-helper/releases/*) ;; *) echo "Release must be under /opt/court-helper/releases" >&2; exit 2;; esac
test -x "$TARGET/server/deploy/scripts/deploy.sh" || { echo "Invalid release" >&2; exit 2; }
test -f /opt/court-helper/current/server/.env || { echo "Current server/.env is missing" >&2; exit 1; }

install -m 600 /opt/court-helper/current/server/.env "$TARGET/server/.env"
install -m 600 /opt/court-helper/current/server/deploy/certs/privkey.pem "$TARGET/server/deploy/certs/privkey.pem"
install -m 644 /opt/court-helper/current/server/deploy/certs/fullchain.pem "$TARGET/server/deploy/certs/fullchain.pem"
ln -sfn "$TARGET" /opt/court-helper/current
exec /opt/court-helper/current/server/deploy/scripts/deploy.sh
