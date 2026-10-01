#!/usr/bin/env sh
# Fails when a built library lacks a sqlite3_* symbol Node imports (node-symbols.txt) or, for a gnu
# build, needs a newer glibc than the floor we promise.
#
#   packages/sqlite/check.sh lib/linux-x64-gnu/libsqlite3.so.0 [glibc-floor]
set -eu

library=$1
floor=${2:-}
here=$(cd "$(dirname "$0")" && pwd)

case $library in
  *.dylib) exported=$(nm -gU "$library" | awk '{print $3}' | sed 's/^_//') ;;
  *) exported=$(nm -D --defined-only "$library" | awk '{print $3}') ;;
esac
missing=$(echo "$exported" | LC_ALL=C sort -u | LC_ALL=C comm -13 - "$here/node-symbols.txt")
if [ -n "$missing" ]; then
  echo "missing symbols Node imports:" >&2
  echo "$missing" >&2
  exit 1
fi

if [ -n "$floor" ]; then
  needed=$(objdump -T "$library" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)
  if [ "$(printf '%s\n%s\n' "$needed" "$floor" | sort -V | tail -1)" != "$floor" ]; then
    echo "needs glibc $needed, above the floor $floor" >&2
    exit 1
  fi
  echo "glibc needed: $needed (floor $floor)"
fi
echo "ok: $library"
