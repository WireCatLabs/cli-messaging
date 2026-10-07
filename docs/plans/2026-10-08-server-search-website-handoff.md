# Handoff — archive preparation on the website (2026-10-08)

The trail, optional, grep `server search` or `NEED-8`: `max-cli/docs_ai/journal/2026-10-07-server-search.md`
(private repo).

## 1. What this is

cli-messaging is the shared layer behind the `tg` and `max` CLIs; cli-docs is their website
([README](../../README.md), [cli-docs README](https://github.com/leemour/cli-docs/blob/main/README.md)). Search
reads a local archive, so it is only as good as what was downloaded. cli-messaging 0.174.0 added
`store fetch --all` (download every chat, the last 90 days by default) and a coverage summary in every search
answer, with `coverage.next` naming the command that would improve it
([plan](2026-10-07-server-search.md), [query language «Машинный контракт и охват»](../search/query-language.md)).
tg and max adopted it on `main` and document it in their guides, but neither has a release that carries it yet.
**Your job:** once both are released, describe archive preparation on the website's
[How search works](https://github.com/leemour/cli-docs/blob/main/content/docs/search-architecture.mdx) page, in
English, Russian and Spanish.

## 2. Orient in one call

```sh
C=~/Projects/AI/cli-messaging; T=~/Projects/AI/tg-cli; M=~/Projects/AI/max-cli; D=~/Projects/AI/cli-docs
{ for r in $C $T $M $D; do git -C $r fetch -q --tags; done
  echo "== newest tags"; for r in $T $M; do echo "$(basename $r): $(git -C $r tag --sort=-v:refname | head -1)"; done
  echo "== does the newest tag carry store fetch --all?"; for r in $T $M; do t=$(git -C $r tag --sort=-v:refname | head -1); echo "$(basename $r) $t: $(git -C $r show $t:docs/search.md | grep -c 'store fetch --all')"; done
  echo "== website pins (tools.json docsRef)"; git -C $D show origin/main:tools.json | grep -n 'repo\|docsRef'
  echo "== how a pin moves"; git -C $D show origin/main:README.md | sed -n '99,105p'
  echo "== page: intro versions, section 1, the JSON paragraph"; git -C $D show origin/main:content/docs/search-architecture.mdx | sed -n '8p;25,31p;60p'
  echo "== tg guide on main: Prepare your archive first"; git -C $T show origin/main:docs/search.md | sed -n '6,42p'
  echo "== coverage contract"; git -C $C show origin/main:docs/search/query-language.md | sed -n '571,580p'
} > ~/.cache/archive-prep-orient.txt 2>&1
```

Then read `~/.cache/archive-prep-orient.txt` (about 80 lines). It shows:
- the newest tg and max tags, and whether each tag's search guide already has `store fetch --all` (0 = not
  released yet: stop and wait);
- the guide versions the website shows (`docsRef`) and the rule for moving them;
- the page's intro line with versions, section 1 «Archive and identity», and the paragraph on the JSON answer;
- the user-facing text tg already uses for archive preparation — the wording to match;
- the coverage fields as the contract defines them.

## 3. Read in this order (only if the orient output is not enough)

1. `cli-docs/content/docs/search-architecture.mdx:25-31` and `:80-85` — where the new text goes, and the
   server-search section it must agree with.
2. The same lines in `search-architecture.ru.mdx` and `.es.mdx` — the three pages have the same line layout.
3. `cli-docs/README.md:99-105` — why `docsRef` moves only after a translation review.
4. `max-cli/docs/search.md:7-42` (`origin/main`) — the Russian wording max uses, for the `.ru.mdx` page.

## 4. Do

1. **Confirm the releases.** Check: the orient output shows `1` or more for both tg and max under «does the newest
   tag carry store fetch --all». If either shows `0`, stop: the release lane has not shipped it.
2. **Add archive preparation to section 1, in all three pages.** One short paragraph after the paragraph on
   ranges: good search needs downloaded chats; `store fetch --all --background` downloads the last 90 days of
   every chat; `--since-time 365d` goes further. Then one sentence in the JSON paragraph (line 60): `coverage`
   also counts messages and chats searched, chats never fetched or behind, up to ten `attention` chats, and
   `next`, the one command that would improve the answer; an agent runs `next` (or asks) before concluding a
   message does not exist. Name the versions that carry it, as line 8 and the word-forms section do.
   Decision yours: whether the terminal line («searched 12,430 messages in 37 chats — …») is worth quoting on a
   technical page; the guides already quote it.
3. **Decide about the guide pins.** The website's tg and max guides come from `docsRef` (tg `v0.28.0`, max
   `v0.29.0`), far behind. Moving them means a translation review of every changed page
   ([README rule](https://github.com/leemour/cli-docs/blob/main/README.md#updating-reviewed-tool-versions)),
   a separate and larger job. The plan leans: leave the pins, link the guides as they are, and say in the reply
   that the pins are behind. Decision yours.
   Check: `pnpm lint && pnpm test && pnpm search:check && pnpm build` in cli-docs — passes.

## 5. What bites

1. **A release changes nothing on the website by itself.** `pnpm sync` copies tg and max guides at the pinned
   `docsRef` tags, not the newest ones, and never from `main`.
2. **`--since-time` takes `m`, `h` and `d` only.** Write `365d`, never `1y`
   (`cli-messaging/src/services/moment.ts:3`).
3. **MAX asks its server only for a search that names one chat.** Do not write that the server makes downloading
   unnecessary: `stats`, topic search, filters and every MAX search without a chat read only the archive.
4. **A chat downloaded back to the 90-day window stays `partial` for good,** and `next` deliberately does not
   name it. Do not describe `partial` as "needs fetching".
5. **The cli-docs main checkout holds another session's uncommitted landing work** (branch
   `design/landing-variants`). Work in a worktree from `origin/main`, and check it exists before editing: a failed
   `git worktree add` (another session's `.git/config.lock`) followed by `cd` leaves you editing the main
   checkout.

## 6. Do not touch

- `cli-docs/tools.json` and `cli-docs/translations/` — only together with a reviewed pin move (step 3).
- `cli-docs/content/docs/tg/` and `content/docs/max/` — written by `pnpm sync`, never by hand.
- tg and max releases — the release lane runs them (owner's choice, 2026-10-08).
- `cli-docs` design work on `design/landing-variants`.

## 7. Check

```sh
pnpm lint && pnpm test && pnpm search:check && pnpm build
```

Run in the cli-docs worktree. `pnpm build` runs `pnpm sync`, which needs the network for the tag checkouts.
