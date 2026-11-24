#!/usr/bin/env bash
# deploy-api.sh — deploy the BeerPassport admin API on the Lightsail box.
#
# OPERATOR-RUN ONLY. This script runs ON the Lightsail instance, never from
# CI: GitHub-hosted runner IPs are ephemeral and the box accepts SSH only
# from Frank's /32. Frank separately approves the digest and deployment.
#
# Usage:
#   scripts/deploy-api.sh <registry/repository@sha256:digest>
#
# Examples:
#   scripts/deploy-api.sh 149290600858.dkr.ecr.us-east-1.amazonaws.com/beerpassport-admin-api@sha256:<64 hex>
#   scripts/deploy-api.sh frankpizz10/beerpassport-admin-api@sha256:<64 hex>   (pre-migration Docker Hub image; rollback path)
#
# ECR references: ECR login tokens expire after 12 hours and the box has
# no AWS CLI, so before pulling, the script refreshes authentication by
# running scripts/ecr-login.py (Python 3 standard library only; see that
# file for the pull-only credential design). The login uses a temporary
# DOCKER_CONFIG directory that is deleted when the script exits, so no
# registry credential persists on disk. Authentication happens BEFORE
# the current container is touched: an auth or pull failure aborts the
# deployment with the running service untouched. Docker Hub references
# (the pre-migration rollback target) skip this path entirely.
#
# Behavior:
#   * The image is pulled and run BY DIGEST. Tags are never trusted as a
#     deployment reference.
#   * The currently running container's image reference is recorded in
#     $BP_ADMIN_HOME/previous-digest BEFORE anything is switched; that file
#     is the rollback target (see scripts/rollback-api.sh).
#   * The old container is stopped and kept, renamed to
#     beerpassport-admin-api-rollback, so a rollback does not depend on the
#     registry being reachable.
#   * The new container must answer GET /admin-api/v1/health within ~60s or
#     the script removes it, restarts the previous container, and exits 1.
#   * Runtime configuration comes only from $BP_ADMIN_HOME/admin-api.env on
#     the box. This script never reads, prints, or logs that file's contents.
#
# State directory: /opt/beerpassport-admin (override with BP_ADMIN_HOME).
# BP_PRESERVE_PREVIOUS=1 is an internal flag used by rollback-api.sh: when
# set, previous-digest is NOT overwritten (see that script for why).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="beerpassport-admin-api"
ROLLBACK_CONTAINER_NAME="beerpassport-admin-api-rollback"
BP_ADMIN_HOME="${BP_ADMIN_HOME:-/opt/beerpassport-admin}"
ENV_FILE="${BP_ADMIN_ENV_FILE:-/etc/beerpassport/secrets/admin-api.env}"
DISCOVERY_STORE_HOST="${BP_DISCOVERY_STORE_HOST:-/var/lib/beerpassport-admin/discovery-images}"
DISCOVERY_STORE_CONTAINER="/var/lib/beerpassport-admin/discovery-images"
PREVIOUS_FILE="${BP_ADMIN_HOME}/previous-digest"
CURRENT_FILE="${BP_ADMIN_HOME}/current-digest"
HEALTH_URL="http://127.0.0.1:4100/admin-api/v1/health"
HEALTH_TRIES=30
HEALTH_INTERVAL_SECONDS=2

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [ $# -ne 1 ]; then
  echo "Usage: $0 <registry/repository@sha256:digest>" >&2
  exit 64
fi
NEW_REF="$1"
if [[ ! "$NEW_REF" =~ @sha256:[0-9a-f]{64}$ ]]; then
  fail "image reference must end with an immutable @sha256:<64 hex> digest, got: ${NEW_REF}"
fi
NEW_DIGEST="${NEW_REF##*@}"

command -v docker >/dev/null 2>&1 || fail "docker is not installed on this box"
command -v curl >/dev/null 2>&1 || fail "curl is not installed on this box"
[ -f "$ENV_FILE" ] || fail "env file not found: ${ENV_FILE} (create it on the box; its contents are never printed by this script)"
[ -d "$DISCOVERY_STORE_HOST" ] || fail "discovery image store directory not found: ${DISCOVERY_STORE_HOST}"
mkdir -p "$BP_ADMIN_HOME"
command -v flock >/dev/null 2>&1 || fail "flock is required to serialize deployments"
exec 9>"${BP_ADMIN_HOME}/deploy.lock"
flock -n 9 || fail "another deployment is running"

# Record the current release as the rollback target BEFORE switching.
PREVIOUS_REF=""
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  PREVIOUS_REF="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME")"
  if [ "${BP_PRESERVE_PREVIOUS:-0}" != "1" ]; then
    printf '%s\n' "$PREVIOUS_REF" > "${PREVIOUS_FILE}.tmp"
    mv "${PREVIOUS_FILE}.tmp" "$PREVIOUS_FILE"
    echo "Recorded rollback target: ${PREVIOUS_REF}"
  else
    echo "Rollback target preserved (not overwritten): $(cat "$PREVIOUS_FILE" 2>/dev/null || echo '<none>')"
  fi
else
  echo "No running ${CONTAINER_NAME} container found; no rollback target recorded."
  echo "If the API is currently running in another form, capture it as the"
  echo "rollback target manually before relying on rollback (see RUNBOOK.md)."
fi

# ECR pulls need a fresh login token (12h expiry, no AWS CLI on the box).
# Refresh it into a throwaway DOCKER_CONFIG before pulling; the config is
# deleted on exit and the running container is untouched if this fails.
if [[ "$NEW_REF" == *.dkr.ecr.*.amazonaws.com/* ]]; then
  ECR_REGISTRY="${NEW_REF%%/*}"
  ECR_LOGIN="${BP_ECR_LOGIN:-${SCRIPT_DIR}/ecr-login.py}"
  [ -x "$ECR_LOGIN" ] || fail "ECR login helper not found or not executable: ${ECR_LOGIN}"
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for ECR authentication on this box"
  TEMP_DOCKER_CONFIG="$(mktemp -d)"
  chmod 700 "$TEMP_DOCKER_CONFIG"
  export DOCKER_CONFIG="$TEMP_DOCKER_CONFIG"
  trap 'rm -rf "$TEMP_DOCKER_CONFIG"' EXIT
  echo "Refreshing ECR authentication for ${ECR_REGISTRY} ..."
  "$ECR_LOGIN" "$ECR_REGISTRY" || fail "ECR authentication failed; deployment aborted before any change"
fi

echo "Pulling ${NEW_REF} ..."
docker pull "$NEW_REF"

# Stop the current container and keep it, stopped, under the rollback name.
SWITCH_STARTED=0
OLD_RENAMED=0
restore_previous() {
  local status=$?
  trap - ERR
  if [ "$SWITCH_STARTED" = 1 ]; then
    echo "Deployment failed; restoring the previous container." >&2
    if [ "$OLD_RENAMED" = 1 ]; then
      docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
      docker rename "$ROLLBACK_CONTAINER_NAME" "$CONTAINER_NAME" || true
    fi
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap restore_previous ERR
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  SWITCH_STARTED=1
  docker stop "$CONTAINER_NAME" >/dev/null
  if docker container inspect "$ROLLBACK_CONTAINER_NAME" >/dev/null 2>&1; then
    docker rm "$ROLLBACK_CONTAINER_NAME" >/dev/null
  fi
  docker rename "$CONTAINER_NAME" "$ROLLBACK_CONTAINER_NAME"
  OLD_RENAMED=1
fi

start_container() {
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    --mount "type=bind,source=$DISCOVERY_STORE_HOST,target=$DISCOVERY_STORE_CONTAINER" \
    -p 127.0.0.1:4100:4100 \
    --memory 288m \
    "$1" >/dev/null
}

wait_for_health() {
  local tries="$1"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fs "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

echo "Starting ${CONTAINER_NAME} from ${NEW_DIGEST} ..."
if ! start_container "$NEW_REF" || ! docker network connect beerpassport-backend "$CONTAINER_NAME" || ! wait_for_health "$HEALTH_TRIES" || ! docker exec "$CONTAINER_NAME" node -e 'const fs=require("fs"); const p=process.env.DISCOVERY_IMAGE_STORE; if(p){ if(p!=="/var/lib/beerpassport-admin/discovery-images") throw new Error("DISCOVERY_IMAGE_STORE does not match the persistent mount"); fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK); }' || ! docker exec "$CONTAINER_NAME" node -e 'const {PrismaClient}=require("@prisma/client"); const p=new PrismaClient(); p.$queryRaw`SELECT 1 FROM beers LIMIT 1`.then(() => p.$disconnect()).catch(async e => { console.error(e.message); await p.$disconnect(); process.exitCode=1; });'; then
  echo "ERROR: new container did not become healthy after $((HEALTH_TRIES * HEALTH_INTERVAL_SECONDS))s." >&2
  echo "----- last logs of the failed container -----" >&2
  docker logs --tail 100 "$CONTAINER_NAME" 2>&1 || true
  echo "----- end of logs -----" >&2
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if docker container inspect "$ROLLBACK_CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Restarting the previous container (${PREVIOUS_REF:-unknown reference})..."
    docker rename "$ROLLBACK_CONTAINER_NAME" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME" >/dev/null
    if wait_for_health "$HEALTH_TRIES"; then
      echo "Previous container is healthy again. No release was deployed."
    else
      echo "WARNING: the previous container did not answer health checks either." >&2
      echo "Investigate immediately: docker logs ${CONTAINER_NAME}" >&2
    fi
  else
    echo "No previous container to restart." >&2
  fi
  exit 1
fi

printf '%s\n' "$NEW_REF" > "${CURRENT_FILE}.tmp"
mv "${CURRENT_FILE}.tmp" "$CURRENT_FILE"
SWITCH_STARTED=0
trap - ERR

echo "Deploy succeeded."
echo "  Running now:      ${NEW_REF}"
if [ -n "$PREVIOUS_REF" ]; then
  echo "  Rollback target:  ${PREVIOUS_REF} (recorded in ${PREVIOUS_FILE})"
  echo "  Roll back with:   scripts/rollback-api.sh"
else
  echo "  Rollback target:  none recorded (first containerized deploy)"
fi
