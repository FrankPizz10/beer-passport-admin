#!/usr/bin/env bash
# Disposable mock tests: no Docker daemon, network, or production access.
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-api.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
mkdir -p "$tmp/discovery-images"
export BP_DISCOVERY_STORE_HOST="$tmp/discovery-images"

cat > "$tmp/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$1 ${2:-}" in
  "container inspect") case "$3" in beerpassport-admin-api) test -f "$MOCK_STATE/main";; *) test -f "$MOCK_STATE/rollback";; esac;;
  "inspect --format") echo 'frankpizz10/beerpassport-admin-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';;
  "pull "*) echo pull >> "$MOCK_STATE/order" 2>/dev/null || true; exit 0;;
  "stop "*) exit 0;;
  "rename "*) if [ "$2" = beerpassport-admin-api ]; then mv "$MOCK_STATE/main" "$MOCK_STATE/rollback"; else mv "$MOCK_STATE/rollback" "$MOCK_STATE/main"; fi;;
  "run -d")
    [[ " $* " == *" --mount type=bind,source=$BP_DISCOVERY_STORE_HOST,target=/var/lib/beerpassport-admin/discovery-images "* ]] || exit 2
    [ "$MOCK_FAIL" != run ] || exit 1; touch "$MOCK_STATE/main" "$MOCK_STATE/new";;
  "network connect") [ "$MOCK_FAIL" != network ];;
  "exec "*)
    if [[ "$*" == *'accessSync'* ]]; then [ "$MOCK_FAIL" != store ]; else [ "$MOCK_FAIL" != database ]; fi;;
  "rm -f") rm -f "$MOCK_STATE/main" "$MOCK_STATE/new";;
  "rm "*) rm -f "$MOCK_STATE/rollback";;
  "start "*) touch "$MOCK_STATE/restored";;
  "logs --tail") exit 0;;
  *) echo "unexpected mocked Docker command: $1 ${2:-}" >&2; exit 2;;
esac
MOCK
cat > "$tmp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
if [ "$MOCK_FAIL" = health ] && [ -f "$MOCK_STATE/new" ]; then exit 1; fi
exit 0
MOCK
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/sleep"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/flock"
chmod +x "$tmp/bin/"*
for failure in run network health store database; do
  state="$tmp/$failure"
  mkdir -p "$state"
  touch "$state/main" "$state/env"
  if PATH="$tmp/bin:$PATH" BP_ADMIN_HOME="$state/home" BP_ADMIN_ENV_FILE="$state/env" MOCK_STATE="$state" MOCK_FAIL="$failure" \
    bash "$script" "frankpizz10/beerpassport-admin-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" > "$state/output" 2>&1; then
    echo "FAIL: $failure did not fail" >&2; exit 1
  fi
  if [ ! -f "$state/restored" ]; then
    cat "$state/output" >&2
    echo "FAIL: $failure did not restore the old container" >&2; exit 1
  fi
  echo "PASS: $failure failure restored the prior container"
done

# --- ECR scenarios -------------------------------------------------------
# A stub login helper stands in for scripts/ecr-login.py (BP_ECR_LOGIN).
cat > "$tmp/bin/ecr-login-stub" <<'MOCK'
#!/usr/bin/env bash
echo ecr-login >> "$MOCK_STATE/order"
[ "$MOCK_FAIL" != ecrlogin ]
MOCK
chmod +x "$tmp/bin/ecr-login-stub"
ecr_ref="149290600858.dkr.ecr.us-east-1.amazonaws.com/beerpassport-admin-api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

# ECR deploy succeeds: login runs before the pull, temp docker config is
# cleaned up, and the Docker Hub reference is recorded as rollback target.
state="$tmp/ecr-ok"; mkdir -p "$state/tmpdir"; touch "$state/main" "$state/env"
if ! PATH="$tmp/bin:$PATH" TMPDIR="$state/tmpdir" BP_ADMIN_HOME="$state/home" BP_ADMIN_ENV_FILE="$state/env" \
  BP_ECR_LOGIN="$tmp/bin/ecr-login-stub" MOCK_STATE="$state" MOCK_FAIL="" \
  bash "$script" "$ecr_ref" > "$state/output" 2>&1; then
  cat "$state/output" >&2; echo "FAIL: ECR deploy did not succeed" >&2; exit 1
fi
grep -q '^ecr-login$' "$state/order" && grep -q '^pull$' "$state/order" || { echo "FAIL: ECR login/pull not recorded" >&2; exit 1; }
[ "$(head -n 1 "$state/order")" = "ecr-login" ] || { echo "FAIL: ECR login did not precede the pull" >&2; exit 1; }
[ -z "$(ls -A "$state/tmpdir")" ] || { echo "FAIL: temporary docker config was left behind" >&2; exit 1; }
grep -q 'frankpizz10/beerpassport-admin-api@sha256:aaaa' "$state/home/previous-digest" || { echo "FAIL: Docker Hub rollback target not recorded" >&2; exit 1; }
echo "PASS: ECR deploy logged in first, pulled, and recorded the Docker Hub rollback target"

# ECR login failure aborts before the running container is touched.
state="$tmp/ecr-authfail"; mkdir -p "$state/tmpdir"; touch "$state/main" "$state/env"
if PATH="$tmp/bin:$PATH" TMPDIR="$state/tmpdir" BP_ADMIN_HOME="$state/home" BP_ADMIN_ENV_FILE="$state/env" \
  BP_ECR_LOGIN="$tmp/bin/ecr-login-stub" MOCK_STATE="$state" MOCK_FAIL="ecrlogin" \
  bash "$script" "$ecr_ref" > "$state/output" 2>&1; then
  echo "FAIL: ECR auth failure did not fail the deploy" >&2; exit 1
fi
grep -q 'ECR authentication failed' "$state/output" || { cat "$state/output" >&2; echo "FAIL: unexpected output on ECR auth failure" >&2; exit 1; }
[ ! -f "$state/restored" ] && [ -f "$state/main" ] && [ ! -f "$state/rollback" ] || { echo "FAIL: ECR auth failure disturbed the running container" >&2; exit 1; }
echo "PASS: ECR auth failure aborted before any change"

# Rollback after the ECR deploy returns to the Docker Hub image and never
# invokes the ECR login helper.
state="$tmp/ecr-ok"
: > "$state/order"
rollback_script="$(dirname "$script")/rollback-api.sh"
if ! PATH="$tmp/bin:$PATH" TMPDIR="$state/tmpdir" BP_ADMIN_HOME="$state/home" BP_ADMIN_ENV_FILE="$state/env" \
  BP_ECR_LOGIN="$tmp/bin/ecr-login-stub" MOCK_STATE="$state" MOCK_FAIL="" \
  bash "$rollback_script" > "$state/rollback-output" 2>&1; then
  cat "$state/rollback-output" >&2; echo "FAIL: rollback to the Docker Hub image failed" >&2; exit 1
fi
if grep -q 'ecr-login' "$state/order"; then echo "FAIL: rollback to a Docker Hub reference invoked ECR login" >&2; exit 1; fi
echo "PASS: rollback to the pre-migration Docker Hub image works without ECR auth"
