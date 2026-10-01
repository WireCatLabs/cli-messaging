#!/bin/sh
cd "$(dirname "$0")"
C=96
for rt in node bun; do
  for t in 1 2 4 8 12; do timeout 180 $rt par.mjs 0 $t $C >>results.jsonl 2>>errors.log || echo "{\"rt\":\"$rt\",\"cell\":\"0x$t\",\"failed\":$?}" >>results.jsonl; done
  for cell in "1 4" "2 4" "2 6" "3 4" "4 2" "4 3" "6 2" "6 1"; do
    set -- $cell
    timeout 180 $rt par.mjs $1 $2 $C >>results.jsonl 2>>errors.log || echo "{\"rt\":\"$rt\",\"cell\":\"$1x$2\",\"failed\":$?}" >>results.jsonl
  done
done
