#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 3 || "$1" != "--confirm-production-restore" ]]; then
  echo "Usage: $0 --confirm-production-restore <backup.tar.age> <age-identity-file>" >&2
  exit 2
fi

BACKUP_FILE="$(realpath "$2")"
IDENTITY_FILE="$(realpath "$3")"
test -s "$BACKUP_FILE" && test -s "$IDENTITY_FILE" || { echo "Backup or identity file is missing" >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
TMP_DIR="$(mktemp -d -t court-helper-restore.XXXXXX)"
cleanup() { case "$TMP_DIR" in /tmp/court-helper-restore.*) rm -rf -- "$TMP_DIR";; esac; }
trap cleanup EXIT

age -d -i "$IDENTITY_FILE" "$BACKUP_FILE" | tar -C "$TMP_DIR" -xf -
test -s "$TMP_DIR/database.dump" && test -s "$TMP_DIR/storage.tar.gz" || { echo "Invalid backup archive" >&2; exit 1; }

set -a
source .env
set +a
docker compose --profile tls stop nginx app
docker compose exec -T db dropdb -U "${POSTGRES_USER:-courthelper}" --if-exists "${POSTGRES_DB:-courthelper}"
docker compose exec -T db createdb -U "${POSTGRES_USER:-courthelper}" "${POSTGRES_DB:-courthelper}"
docker compose exec -T db pg_restore -U "${POSTGRES_USER:-courthelper}" -d "${POSTGRES_DB:-courthelper}" --clean --if-exists < "$TMP_DIR/database.dump"
docker run --rm -v "${COMPOSE_PROJECT_NAME:-court-helper}_storage-data:/data" alpine:3.21 sh -c 'find /data -mindepth 1 -delete'
docker run --rm -i -v "${COMPOSE_PROJECT_NAME:-court-helper}_storage-data:/data" alpine:3.21 tar -C /data -xzf - < "$TMP_DIR/storage.tar.gz"
docker compose --profile tls up -d
echo "Restore completed; run deploy.sh health verification and the acceptance checklist."
