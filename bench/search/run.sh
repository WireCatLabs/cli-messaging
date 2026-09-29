#!/usr/bin/env bash
# Usage: run.sh N [bun]. One engine at a time; each engine's database is removed after it is measured,
# because the data dir is tmpfs and shares RAM with the engines.
set -euo pipefail
cd "$(dirname "$0")"
N="$1"
DATA="${SEARCHBENCH_DATA:-/tmp/claude-1000/-home-leemour-Projects-AI-max-cli/acc4d3ed-02a6-41d5-8e9a-d5b4a62b9ac4/scratchpad/searchbench-data}"
R=results.md
build_header() {
  { echo; echo "#### Build — $1"; echo
    echo "| engine | runtime | N | variant | load | index build | disk | peak RSS |"
    echo "|---|---|---|---|---|---|---|---|"; } >> $R
}
section() { { echo; echo "#### $1"; echo; } >> $R; }

echo >> $R; echo "## N = $N ${2:-}" >> $R

if [ "${2:-}" = "bun" ]; then
  build_header "sqlite under Bun"; bun sqlite.ts build "$N" after
  section "Queries — sqlite under Bun"; bun sqlite.ts query "$N"
  rm -rf "$DATA/sqlite-$N-bun-after"
  build_header "pglite under Bun"; bun pglite.ts build "$N"
  section "Queries — pglite under Bun"; bun pglite.ts query "$N"
  rm -rf "$DATA/pglite-$N-bun"
  exit 0
fi

build_header "sqlite"
if [ "$N" -le 100000 ]; then
  node sqlite.ts build "$N" inline
  rm -rf "$DATA/sqlite-$N-node-inline"
fi
node sqlite.ts build "$N" after
section "Queries — sqlite"; PLANS=1 node sqlite.ts query "$N"
rm -rf "$DATA/sqlite-$N-node-after"

build_header "pglite"; node pglite.ts build "$N"
section "Queries — pglite"; PLANS=1 node pglite.ts query "$N"
rm -rf "$DATA/pglite-$N-node"

rm -rf "$DATA/pgdocker-$N"
./docker-pg.sh start "$N" > /dev/null
build_header "docker postgres"; node pgdocker.ts build "$N"
docker restart "$(cat "$DATA/pgdocker-$N.cid")" > /dev/null; sleep 3
section "Queries — docker postgres"; PLANS=1 node pgdocker.ts query "$N"
./docker-pg.sh stop "$N"
