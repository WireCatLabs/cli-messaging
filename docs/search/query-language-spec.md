# Lucene query profile v1 — техническая спецификация

**Планируется; реализация A1 в feat/search-lucene-a1.** Публичные options и output contract
одобрены владельцем 2026-10-03. Русский язык canonical guide/spec — явное требование этой работы;
прочие shared documents остаются английскими.

## Baseline и provenance

[StandardSyntaxParser 9.12.3](https://github.com/apache/lucene/blob/releases/lucene/9.12.3/lucene/queryparser/src/java/org/apache/lucene/queryparser/flexible/standard/parser/StandardSyntaxParser.jj)
и официальный PrecedenceQueryParser, defaultOperator AND, default field text.
Parser выбирается по differential conformance corpus; при отсутствии подходящей библиотеки
переносится upstream grammar с Apache-2.0 license/notices. Java — только development harness.
SQL backend и normalization v1 остаются; full Lucene compatibility не заявляется.

## Контракт

Versioned syntax/typed AST; clause occurrences required/optional/prohibited; spans UTF-16 [start,end).
One field registry: types/operators/resolver/index/normalization/enums/version/support stage.
Authority scope задаётся отдельно. Typed date endpoints — UTC milliseconds; ids — strings.
Structured/text queries используют один validator. Legacy parsing не определяется содержимым query.

## Исполнение

Bound SQL/FTS, Boolean operations до LIMIT, strict matching и стабильный tie-breaker.
Незавершённый word index не включает substring fallback.
text использует documented tokenizer и normalization v1, body — исходный case-sensitive keyword.
Lucene regex — bounded automaton; legacy JS regex — isolated deadline-limited execution.

Предложенные budgets: 8 KiB query, 32 depth, 256 nodes, 1024 pattern code points,
10k automaton states/term expansions, 50k candidates, 8 MiB bodies, 2s execution deadline.
Reference tests и 100k/1M benchmarks уточняют их до выпуска.

## Проверки

Reference fixtures: explicit/implicit Boolean, modifiers/pure negatives, repeated/grouped fields,
escaping/Unicode, mixed ranges, unsupported operators, regex term/body semantics.
Synthetic CLI/MCP/service ids должны совпадать для двух providers; account isolation, DST,
strict zero hits, empty-query coverage, worker teardown и error paths обязательны.
Generated registry docs и executable recipes проверяются на drift.

[Пользовательская справка](query-language.md)
