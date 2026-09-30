#!/usr/bin/env bash
# Usage: docker-pg.sh start N | stop N. Keeps the container id in the data dir; stops by that id only.
set -euo pipefail
DATA="${SEARCHBENCH_DATA:-${TMPDIR:-/tmp}/searchbench-data}"
N="$2"
PGDIR="$DATA/pgdocker-$N"
IDFILE="$DATA/pgdocker-$N.cid"
case "$1" in
  start)
    mkdir -p "$PGDIR"
    docker run -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=bench \
      -v "$PGDIR:/home/postgres/pgdata/data" -v "$DATA:/data:ro" \
      timescale/timescaledb-ha:pg18 \
      postgres -c shared_preload_libraries=timescaledb,pg_textsearch -c shared_buffers=256MB -c maintenance_work_mem=256MB \
      -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_wal_size=4GB > "$IDFILE"
    for _ in $(seq 120); do
      if docker logs "$(cat "$IDFILE")" 2>&1 | grep -q -E "init process complete|Skipping initialization" &&
        docker exec "$(cat "$IDFILE")" pg_isready -h 127.0.0.1 -q 2>/dev/null; then break; fi
      sleep 1
    done
    echo "started $(cat "$IDFILE" | cut -c1-12)"
    ;;
  stop)
    docker stop "$(cat "$IDFILE")" > /dev/null && docker rm "$(cat "$IDFILE")" > /dev/null
    rm -f "$IDFILE"
    ;;
esac
