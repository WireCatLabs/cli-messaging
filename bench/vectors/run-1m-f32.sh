#!/bin/sh
N24=$HOME/.nvm/versions/node/v24.19.0/bin/node
export JM=DELETE
for d in 384 768; do for rt in "$N24" bun; do
  rm -f db/b.db db/b.db-journal db/b.db-wal db/b.db-shm
  $rt bench.mjs insert 1000000 $d f32 db/b.db; df -h /tmp | tail -1; $rt bench.mjs query 1000000 $d f32 db/b.db
  rm -f db/b.db db/b.db-journal db/b.db-wal db/b.db-shm
  $rt bench.mjs vec0 1000000 $d f32 db/b.db 2>&1 | tail -1
  rm -f db/b.db db/b.db-journal db/b.db-wal db/b.db-shm
done; done
echo DONE
