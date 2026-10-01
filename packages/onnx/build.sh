#!/bin/sh
# Copies the three files ONNX Runtime's Node build loads out of onnxruntime-web's npm tarball, after
# checking the tarball against the integrity npm records — the other 130 MB of that package are browser
# builds nobody here runs.
set -eu
cd "$(dirname "$0")"
VERSION=1.30.0
INTEGRITY="sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ=="
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$VERSION.tgz" -o "$work/web.tgz"
actual="sha512-$(openssl dgst -sha512 -binary "$work/web.tgz" | base64 | tr -d '\n')"
[ "$actual" = "$INTEGRITY" ] || { echo "onnxruntime-web-$VERSION.tgz is not the file npm records" >&2; exit 1; }
tar -xzf "$work/web.tgz" -C "$work"
rm -rf dist && mkdir dist
for file in ort.node.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
  cp "$work/package/dist/$file" dist/
done
ls -l dist
