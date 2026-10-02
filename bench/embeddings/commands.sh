#!/usr/bin/env bash
# Phase 5 item 8 at N messages: build, embed with 1 and 3 workers, and search one-shot and warm, on Node and Bun.
# Usage: ./commands.sh <dir> <N>   (after `pnpm build` at the repository root; e5-small downloaded)
set -euo pipefail
here=$(dirname "$0")
dir=$1
n=$2
mkdir -p "$dir"
timed() { /usr/bin/time -f "%e s, %M KB peak" "$@" 2>&1 >/dev/null | grep -v "skill install" | tail -n 1; }
queries=("встреча" "empadronamiento" "когда будет встреча по поводу аренды квартиры и договора" "where is the contract for the flat and the bank papers")

echo "## N = $n, $(date -u +%FT%TZ)"
[ -f "$dir/messages.db" ] || node "$here/commands.mjs" setup "$dir" "$n"
echo "build (node): $(timed node "$here/commands.mjs" run "$dir" conversations build --chat 1)"
node "$here/commands.mjs" run "$dir" --json conversations embed status --chat 1
for rt in node bun; do
  for workers in 1 3; do
    node "$here/commands.mjs" run "$dir" conversations embed clear --chat 1 >/dev/null 2>&1
    echo "embed ($rt, $workers workers): $(timed "$rt" "$here/commands.mjs" run "$dir" conversations embed --chat 1 --workers "$workers")"
  done
done
for rt in node bun; do
  for query in "${queries[@]}"; do
    for _ in 1 2 3; do echo "search one-shot ($rt) \"$query\": $(timed "$rt" "$here/commands.mjs" run "$dir" conversations search --json "$query")"; done
    echo "search warm ($rt) \"$query\", 11 runs: $("$rt" "$here/commands.mjs" warm "$dir" 11 "$query")"
  done
done
echo "store: $(du -h "$dir/messages.db" | cut -f1)"
