#!/bin/sh
for m in e5 minilm granite gemma gemmaq4; do
  for rt in node bun; do
    $rt bench.mjs $m 4 >> results.jsonl 2>> errors.log || echo "FAIL $rt $m 4" >> errors.log
    $rt bench.mjs $m 1 speed >> results.jsonl 2>> errors.log || echo "FAIL $rt $m 1" >> errors.log
  done
done
echo done >> results.jsonl
