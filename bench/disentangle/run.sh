#!/usr/bin/env bash
# Usage: DISENTANGLE_DATA=<dir> run.sh [test|dev]. Clones the IRC corpus into <dir> once (about 90 MB,
# CC BY 4.0) — never inside this repository — then scores each variant with the corpus's own scripts.
set -euo pipefail
cd "$(dirname "$0")"
: "${DISENTANGLE_DATA:?set DISENTANGLE_DATA to a directory outside this repository}"
SPLIT="${1:-test}"
[ -d "$DISENTANGLE_DATA/data" ] || git clone -q --depth 1 https://github.com/jkkummerfeld/irc-disentanglement.git "$DISENTANGLE_DATA"
EVAL="$DISENTANGLE_DATA/tools/evaluation"
OUT="$DISENTANGLE_DATA/out/$SPLIT"

node --experimental-strip-types irc.ts "$SPLIT" > /dev/null
for variant in previous mention same-sender rules rules+previous; do
  echo "== $variant"
  python3 "$EVAL/graph-eval.py" --gold "$DISENTANGLE_DATA/data/gold.$SPLIT.graphs.txt" --auto "$OUT/$variant.graphs.txt" | grep "^p/r/f"
  uv run -q --python 3.10 --with 'ortools<9.4' --with scikit-learn python3 "$EVAL/conversation-eval.py" \
    "$DISENTANGLE_DATA/data/gold.$SPLIT.clusters.txt" "$OUT/$variant.clusters.txt" --metric vi 1-1 ex
done
