#!/usr/bin/env bash
# Disposable mock tests: no Docker daemon, network, or production access.
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-api.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$1 ${2:-}" in
  "container inspect") case "$3" in beerpassport-admin-api) test -f "$MOCK_STATE/main";; *) test -f "$MOCK_STATE/rollback";; esac;;
  "inspect --format") echo 'frankpizz10/beerpassport-admin-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';;
  "pull "*) exit 0;;
  "stop "*) exit 0;;
  "rename "*) if [ "$2" = beerpassport-admin-api ]; then mv "$MOCK_STATE/main" "$MOCK_STATE/rollback"; else mv "$MOCK_STATE/rollback" "$MOCK_STATE/main"; fi;;
  "run -d") [ "$MOCK_FAIL" != run ] || exit 1; touch "$MOCK_STATE/main" "$MOCK_STATE/new";;
  "network connect") [ "$MOCK_FAIL" != network ];;
  "exec "*) [ "$MOCK_FAIL" != database ];;
  "rm -f") rm -f "$MOCK_STATE/main" "$MOCK_STATE/new";;
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
for failure in run network health database; do
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
