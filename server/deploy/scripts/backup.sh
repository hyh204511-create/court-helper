#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
test -f .env || { echo "Missing server/.env" >&2; exit 1; }

set -a
source .env
set +a
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to the customer backup public key}"
: "${COS_BACKUP_URI:?Set COS_BACKUP_URI, for example cos://private-bucket/court-helper}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_DIR="$(mktemp -d -t court-helper-backup.XXXXXX)"
cleanup() { case "$TMP_DIR" in /tmp/court-helper-backup.*) rm -rf -- "$TMP_DIR";; esac; }
trap cleanup EXIT

docker compose exec -T db pg_dump -U "${POSTGRES_USER:-courthelper}" -d "${POSTGRES_DB:-courthelper}" -Fc > "$TMP_DIR/database.dump"
docker run --rm -v "${COMPOSE_PROJECT_NAME:-court-helper}_storage-data:/data:ro" alpine:3.21 tar -C /data -czf - . > "$TMP_DIR/storage.tar.gz"
printf '%s\n' "$STAMP" > "$TMP_DIR/created-at.txt"
tar -C "$TMP_DIR" -cf - database.dump storage.tar.gz created-at.txt | age -r "$BACKUP_AGE_RECIPIENT" -o "$TMP_DIR/court-helper-$STAMP.tar.age"
coscli cp "$TMP_DIR/court-helper-$STAMP.tar.age" "$COS_BACKUP_URI/court-helper-$STAMP.tar.age"
echo "Encrypted backup uploaded: court-helper-$STAMP.tar.age"
