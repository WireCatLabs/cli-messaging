#!/usr/bin/env sh
# Builds one library into lib/<target>/ from the official amalgamation.
#
#   packages/sqlite/build.sh darwin | linux-x64-gnu | linux-arm64-gnu | linux-x64-musl | linux-arm64-musl
set -eu

target=$1
here=$(cd "$(dirname "$0")" && pwd)
# SQLite publishes the SHA3-256 (download.html); this SHA-256 is of the same file, checked against it on 2026-10-01.
url=https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip
sha256=1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d

work=$(mktemp -d)
curl -sSfL "$url" -o "$work/sqlite.zip"
if command -v sha256sum >/dev/null; then sum=sha256sum; else sum="shasum -a 256"; fi
echo "$sha256  $work/sqlite.zip" | $sum -c - >/dev/null
unzip -q "$work/sqlite.zip" -d "$work"
source=$(find "$work" -name sqlite3.c)

# Homebrew's set (Formula/s/sqlite.rb), plus what Node's own build enables: a Node linked to the
# system library exits at start-up on any sqlite3_* symbol it cannot find.
flags="-O2 -DSQLITE_ENABLE_API_ARMOR=1 -DSQLITE_ENABLE_COLUMN_METADATA=1 -DSQLITE_ENABLE_DBSTAT_VTAB=1
  -DSQLITE_ENABLE_FTS3=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1 -DSQLITE_ENABLE_GEOPOLY=1
  -DSQLITE_ENABLE_JSON1=1 -DSQLITE_ENABLE_MATH_FUNCTIONS=1 -DSQLITE_ENABLE_PREUPDATE_HOOK=1
  -DSQLITE_ENABLE_RBU=1 -DSQLITE_ENABLE_RTREE=1 -DSQLITE_ENABLE_SESSION=1 -DSQLITE_ENABLE_STAT4=1
  -DSQLITE_ENABLE_UNLOCK_NOTIFY=1 -DSQLITE_MAX_VARIABLE_NUMBER=250000 -DSQLITE_USE_URI=1"

mkdir -p "$here/lib/$target"
case $target in
  darwin)
    out=$here/lib/darwin/libsqlite3.dylib
    # 13.0 is Bun's own minimum macOS; without it the library takes the runner's version and
    # refuses to load on older systems.
    # shellcheck disable=SC2086
    clang $flags -arch arm64 -arch x86_64 -mmacosx-version-min=13.0 -dynamiclib \
      -install_name @rpath/libsqlite3.dylib "$source" -o "$out"
    strip -x "$out"
    # Stripping breaks the linker's ad-hoc signature, and Apple Silicon loads no unsigned code.
    codesign -s - -f "$out"
    ;;
  linux-*)
    out=$here/lib/$target/libsqlite3.so.0
    # shellcheck disable=SC2086
    cc $flags -fPIC -shared -Wl,-soname,libsqlite3.so.0 "$source" -o "$out" -lm -lpthread -ldl
    strip --strip-unneeded "$out"
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 1
    ;;
esac
rm -rf "$work"
echo "$out"
