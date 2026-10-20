#!/usr/bin/env bash
# subset-katakana-font.sh — regenerate assets/fonts/IBMPlexSansJP-Katakana.ttf
#
# NEX-303. The katakana face behind the loading-surface glyph rain
# (src/components/ui/MatrixRain.tsx). This script exists so the bundled .ttf is
# a reproducible artifact rather than a mystery binary in git.
#
# WHY A SUBSET: full IBM Plex Sans JP is ~5MB of CJK. The rain needs 46 katakana
# glyphs. Subsetting to the katakana block gets it to ~10KB — smaller than any
# font already bundled (IBMPlexMono-Regular is 131KB, Inter-Regular is 335KB).
#
# WHY THIS FACE: CLAUDE.md §2 locks the typeface list at Fraunces + Inter + IBM
# Plex Mono, and §19 blacklists "more than three typefaces total". Both were
# amended to sanction exactly this one addition. Plex Sans JP is the same Plex
# superfamily as the Plex Mono already shipping, so it widens the existing voice
# rather than importing a foreign one. It is loaded for the rain and NOTHING
# else — no UI text may resolve it.
#
# LICENSE: SIL Open Font License 1.1. The license ships alongside the font at
# assets/fonts/IBMPlexSansJP-OFL.txt, which the OFL requires. (The other bundled
# faces are also OFL but predate this practice and ship no license file — worth
# fixing separately, out of scope here.)
#
# Source is the @fontsource package rather than IBM's GitHub release because
# fontsource publishes a pre-split "japanese" subset; note it ships woff2 only,
# so pyftsubset does double duty as converter (needs brotli) and subsetter.
#
# Usage:  ./scripts/subset-katakana-font.sh
# Deps:   python3, npm. Installs fonttools + brotli into a throwaway venv.

set -euo pipefail

VERSION="5.2.8"
# Weight 500 (Medium) pairs with the bundled IBMPlexMono-Medium the rain's
# Latin glyphs use, so katakana and Latin sit at matching optical weight.
WEIGHT="500"
UNICODES="U+30A0-30FF"   # the katakana block

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO_ROOT/assets/fonts/IBMPlexSansJP-Katakana.ttf"
LICENSE_OUT="$REPO_ROOT/assets/fonts/IBMPlexSansJP-OFL.txt"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "==> installing fonttools"
python3 -m venv .venv
./.venv/bin/pip install --quiet fonttools brotli

echo "==> fetching @fontsource/ibm-plex-sans-jp@$VERSION"
npm pack "@fontsource/ibm-plex-sans-jp@$VERSION" --silent >/dev/null
tar -xzf "fontsource-ibm-plex-sans-jp-$VERSION.tgz"

SRC="package/files/ibm-plex-sans-jp-japanese-$WEIGHT-normal.woff2"
[ -f "$SRC" ] || { echo "source not found: $SRC" >&2; exit 1; }

echo "==> subsetting $UNICODES"
# --layout-features='' drops GSUB/GPOS: the rain draws one isolated glyph at a
# time, so shaping features are dead weight.
./.venv/bin/pyftsubset "$SRC" \
  --unicodes="$UNICODES" \
  --output-file="$OUT" \
  --name-IDs='*' --name-legacy --name-languages='*' \
  --layout-features='' --no-hinting --desubroutinize

cp package/LICENSE "$LICENSE_OUT"

echo "==> verifying coverage against the rain's alphabet"
./.venv/bin/python - "$OUT" <<'PY'
import sys
from fontTools.ttLib import TTFont
# Must stay in sync with KATAKANA in src/components/ui/matrix-rain-motion.ts.
ALPHABET = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン'
cmap = TTFont(sys.argv[1]).getBestCmap()
missing = [c for c in ALPHABET if ord(c) not in cmap]
if missing:
    print('MISSING glyphs: %r' % missing, file=sys.stderr)
    sys.exit(1)
print('ok: %d katakana codepoints, all %d alphabet glyphs present'
      % (len([c for c in cmap if 0x30A0 <= c <= 0x30FF]), len(ALPHABET)))
PY

echo "==> wrote $OUT ($(du -h "$OUT" | cut -f1))"
