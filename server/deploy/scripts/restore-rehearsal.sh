#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <backup.tar.age> <age-identity-file>" >&2
  exit 2
fi

BACKUP_FILE="$(realpath "$1")"
IDENTITY_FILE="$(realpath "$2")"
test -s "$BACKUP_FILE" && test -s "$IDENTITY_FILE" || { echo "Backup or identity file is missing" >&2; exit 2; }

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t court-helper-rehearsal.XXXXXX)"
PROJECT="court-helper-rehearsal-$$"
cleanup() {
  if [[ -f "$TMP_DIR/server/docker-compose.yml" ]]; then
    (cd "$TMP_DIR/server" && COMPOSE_PROJECT_NAME="$PROJECT" HTTP_PORT=18080 HTTPS_PORT=18443 docker compose --profile tls down -v --remove-orphans) || true
  fi
  case "$TMP_DIR" in /tmp/court-helper-rehearsal.*) rm -rf -- "$TMP_DIR";; esac
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/server/deploy/certs"
cp -a "$SOURCE_ROOT/." "$TMP_DIR/server/"
MASTER_KEY="$(openssl rand -base64 32)"
ADMIN_PASSWORD="$(openssl rand -base64 24)"
cat > "$TMP_DIR/server/.env" <<EOF
POSTGRES_DB=courthelper
POSTGRES_USER=courthelper
POSTGRES_PASSWORD=$(openssl rand -base64 24)
CREDENTIAL_MASTER_KEY=$MASTER_KEY
ADMIN_INITIAL_PASSWORD=$ADMIN_PASSWORD
CORS_EXTENSION_ORIGINS=chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CORS_ADMIN_ORIGINS=https://court.hyhbrand.xyz
LOCAL_STORAGE_DIR=/var/lib/court-helper/storage
PORT=3000
LOCAL_LOGIN_HELPER_AUTOSTART=false
EOF
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "$TMP_DIR/server/deploy/certs/privkey.pem" \
  -out "$TMP_DIR/server/deploy/certs/fullchain.pem" \
  -subj '/CN=court.hyhbrand.xyz' >/dev/null 2>&1

cd "$TMP_DIR/server"
export COMPOSE_PROJECT_NAME="$PROJECT" HTTP_PORT=18080 HTTPS_PORT=18443
docker compose up -d db app
./deploy/scripts/restore.sh --confirm-production-restore "$BACKUP_FILE" "$IDENTITY_FILE"
docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/health').then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))"
echo "Isolated restore rehearsal passed; temporary containers, volumes, and plaintext files will now be destroyed."
