#!/usr/bin/env bash
#
# Refresh backend/preset_seed/ from the currently-built presets in
# <data>/nptoy/common/. Run this on the DEV box after you change a preset's nptool
# source (and rebuilt it), then commit — so deploys (which lack the nptool project
# sources) still get every preset. See common.py:build_common / _seed_preset.
#
#   ./backend/refresh_preset_seed.sh
#   PORTAL_DATA_ROOT=/path/to/data ./backend/refresh_preset_seed.sh   # non-default data root
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT="${PORTAL_DATA_ROOT:-$HERE/../../data}"
SRC="$DATA_ROOT/nptoy/common"
SEED="$HERE/preset_seed"

[ -d "$SRC" ] || { echo "✗ built presets not found: $SRC (run the backend once to build them)"; exit 1; }

rm -rf "$SEED"; mkdir -p "$SEED"
n=0
for d in "$SRC"/*/; do
  name="$(basename "$d")"
  [ -f "$d/manifest.json" ] || continue      # a real preset (skip scripts/shared/styles_shared)
  cp -R "$d" "$SEED/$name"
  n=$((n + 1))
done

echo "✓ seeded $n presets → $SEED"
ls "$SEED" | sed 's/^/    /'
echo "→ now: git add backend/preset_seed && git commit"
