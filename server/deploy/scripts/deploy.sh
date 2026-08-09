#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

test -f .env || { echo "Missing server/.env" >&2; exit 1; }
test -s deploy/certs/fullchain.pem || { echo "Missing deploy/certs/fullchain.pem" >&2; exit 1; }
test -s deploy/certs/privkey.pem || { echo "Missing deploy/certs/privkey.pem" >&2; exit 1; }
chmod 600 .env deploy/certs/privkey.pem

docker compose --profile tls config --quiet
docker compose --profile tls up -d --build
docker compose --profile tls ps

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error https://court.hyhbrand.xyz/health >/dev/null; then
    echo "court-helper is healthy"
    exit 0
  fi
  sleep 2
done

docker compose --profile tls logs --tail=100 app nginx >&2
echo "Health check failed" >&2
exit 1
