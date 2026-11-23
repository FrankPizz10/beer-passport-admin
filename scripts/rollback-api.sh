#!/usr/bin/env bash
# rollback-api.sh — return the BeerPassport admin API on the Lightsail box
# to the release recorded in $BP_ADMIN_HOME/previous-digest.
#
# OPERATOR-RUN ONLY, on the Lightsail instance. Usage:
#   scripts/rollback-api.sh
#
# State discipline (why this is not just `deploy-api.sh $(cat previous-digest)`):
#   previous-digest is the operator's known-good rollback target. It is
#   written ONLY by a forward deploy (deploy-api.sh), which records the
#   release it is about to replace. If rollback simply exec'd deploy-api.sh,
#   the deploy would first overwrite previous-digest with the BAD release
#   currently running, and the known-good target would be lost from the
#   recorded state: a second rollback would then "roll back" to the bad
#   release. So this script:
#     1. reads the target from previous-digest,
#     2. records the release being displaced in displaced-digest (forensics;
#        it is never used as an automatic target),
#     3. runs deploy-api.sh with BP_PRESERVE_PREVIOUS=1 so previous-digest
#        still names the same known-good target afterwards. Running
#        rollback-api.sh twice in a row is therefore a no-op the second
#        time, never a ping-pong back to the bad release.
#   To make the displaced release the new rollback target (i.e. accept it
#   again), deploy it forward with deploy-api.sh; do not edit state files
#   by hand except to recover from a documented incident.
#
# Health behavior is inherited from deploy-api.sh: if the rollback target
# does not become healthy, the script restarts the container that was
# running before the rollback and exits 1.
set -euo pipefail

BP_ADMIN_HOME="${BP_ADMIN_HOME:-/opt/beerpassport-admin}"
PREVIOUS_FILE="${BP_ADMIN_HOME}/previous-digest"
DISPLACED_FILE="${BP_ADMIN_HOME}/displaced-digest"
CONTAINER_NAME="beerpassport-admin-api"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[ -f "$PREVIOUS_FILE" ] || fail "no rollback target recorded (${PREVIOUS_FILE} does not exist)"
TARGET_REF="$(tr -d '[:space:]' < "$PREVIOUS_FILE")"
[ -n "$TARGET_REF" ] || fail "rollback target file is empty: ${PREVIOUS_FILE}"
if [[ ! "$TARGET_REF" =~ @sha256:[0-9a-f]{64}$ ]]; then
  fail "recorded rollback target is not a digest reference: ${TARGET_REF}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -x "${SCRIPT_DIR}/deploy-api.sh" ] || fail "deploy-api.sh not found next to this script"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  DISPLACED_REF="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME")"
  printf '%s\n' "$DISPLACED_REF" > "${DISPLACED_FILE}.tmp"
  mv "${DISPLACED_FILE}.tmp" "$DISPLACED_FILE"
  echo "Release being displaced: ${DISPLACED_REF} (recorded in ${DISPLACED_FILE})"
fi

echo "Rolling back to: ${TARGET_REF}"
BP_PRESERVE_PREVIOUS=1 "${SCRIPT_DIR}/deploy-api.sh" "$TARGET_REF"
echo "Rollback complete. Rollback target is unchanged: ${TARGET_REF}"
