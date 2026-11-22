#!/bin/bash
# Drift check: compare this read copy against the pilot schema, ignoring the
# header comment lines added at the top of the copy. Comparison starts at the
# first line matching "generator client" in both files.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PILOT="${PILOT_SCHEMA:-$HOME/workspace/workstreams/pilot-impl/repo/prisma/schema.prisma}"
COPY="$HERE/prisma/schema.prisma"
if [ ! -f "$PILOT" ]; then echo "Pilot schema not found at $PILOT" >&2; exit 2; fi
extract() { awk '/^generator client/{found=1} found' "$1"; }
if diff -u <(extract "$PILOT") <(extract "$COPY") > /tmp/schema-drift.diff; then
  echo "Schema copy is in sync with the pilot schema."
else
  echo "SCHEMA DRIFT DETECTED:" >&2; cat /tmp/schema-drift.diff >&2; exit 1
fi
