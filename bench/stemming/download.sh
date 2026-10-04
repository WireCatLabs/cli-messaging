#!/usr/bin/env bash
# Fetches the pinned inputs into data/ (gitignored): UD treebanks at their r2.18 commits, the Snowball
# compiler at v3.1.1 (built here to generate the official JavaScript stemmers) and its test vocabularies.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/ud data/snowball-data
ud() {
  local repo="$1" sha="$2"; shift 2
  mkdir -p "data/ud/$repo"
  for f in LICENSE.txt README.md "$@"; do
    [ -s "data/ud/$repo/$f" ] || curl -fsSL -o "data/ud/$repo/$f" \
      "https://raw.githubusercontent.com/UniversalDependencies/$repo/$sha/$f"
  done
}
# r2.18 tag commits.
ud UD_Russian-SynTagRus 6377522610550b696fcc70d39074d2ce03da0e7b \
  ru_syntagrus-ud-train-a.conllu ru_syntagrus-ud-train-b.conllu ru_syntagrus-ud-train-c.conllu \
  ru_syntagrus-ud-dev.conllu ru_syntagrus-ud-test.conllu
ud UD_Russian-GSD 9acc9d677327043bd416fcc89e4b3407c620d885 \
  ru_gsd-ud-train.conllu ru_gsd-ud-dev.conllu ru_gsd-ud-test.conllu
ud UD_Spanish-AnCora 197cca385e0e7db1b1fe26a5772dade1b6fbbee8 \
  es_ancora-ud-train.conllu es_ancora-ud-dev.conllu es_ancora-ud-test.conllu
ud UD_English-EWT b7711cce01cdd4f5fcc0a8199b8a50d951b16c0c \
  en_ewt-ud-train.conllu en_ewt-ud-dev.conllu en_ewt-ud-test.conllu

DATA_SHA=a0ec0d0a2839ec885878868de20fcb63209d92b0
for lang in russian spanish; do
  mkdir -p "data/snowball-data/$lang"
  for f in voc.txt output.txt; do
    [ -s "data/snowball-data/$lang/$f" ] || curl -fsSL -o "data/snowball-data/$lang/$f" \
      "https://raw.githubusercontent.com/snowballstem/snowball-data/$DATA_SHA/$lang/$f"
  done
done

# v3.1.1 tag commit.
SNOWBALL_SHA=cd195b51e948a902a4312f023f4a14392516a543
if [ ! -s data/snowball/js/russian-stemmer.js ]; then
  rm -rf data/snowball
  git init -q data/snowball
  git -C data/snowball fetch -q --depth 1 https://github.com/snowballstem/snowball.git "$SNOWBALL_SHA"
  git -C data/snowball checkout -q FETCH_HEAD
  make -C data/snowball -s -j8 snowball >/dev/null
  mkdir -p data/snowball/js
  for lang in russian spanish english; do
    data/snowball/snowball "data/snowball/algorithms/$lang.sbl" -js -o "data/snowball/js/$lang-stemmer"
  done
  cp data/snowball/javascript/base-stemmer.js data/snowball/js/
fi
echo "ok: $(du -sh data | cut -f1) in data/"
