#!/bin/sh
N24=$HOME/.nvm/versions/node/v24.19.0/bin/node
for n in 10000 100000 1000000; do for d in 384 768; do for k in f32 i8; do
  [ $n = 1000000 ] && [ $d = 768 ] && [ $k = f32 ] && continue
  for rt in "$N24" bun; do
    f=db/b.db; rm -f db/b.db db/b.db-wal db/b.db-shm
    $rt bench.mjs insert $n $d $k $f; $rt bench.mjs query $n $d $k $f
    rm -f db/b.db db/b.db-wal db/b.db-shm
    $rt bench.mjs vec0 $n $d $k $f 2>&1 | tail -1
    rm -f db/b.db db/b.db-wal db/b.db-shm
  done
done; done; done
echo DONE
