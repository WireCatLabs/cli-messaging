# Поиск в локальном архиве

**Планируется: Lucene profile v1.** До выпуска используйте текущий legacy search.

Поиск читает только локальную БД. Пустой результат не доказывает отсутствие сообщения
в мессенджере. Проверяйте охват и полноту архива.

## Язык и миграция

Планируется `messages search --language lucene|legacy`, default lucene. Стандартная основа:
Apache Lucene 9.12.3 StandardSyntaxParser и PrecedenceQueryParser, default AND, поле text.
Legacy mode сохраняет прежние filters, typo correction и substring fallback.
`--regex` остаётся отдельным legacy JavaScript regex с case-insensitive full-body matching.
Сочетание `--regex --language lucene` будет ошибкой.

## Поля и операторы

Слова, quoted phrases, Boolean AND/OR/NOT, группы полей и inclusive/exclusive ranges
входят в первую версию. text — analyzed tokens, body — полный исходный текст.
from/chat разрешают имена только в выбранных accounts; date использует timezone.
kind различает peer kinds; in выбирает account provider, поэтому kind:bot и in:bots различаются.
has, topic и проверенные preset predicates входят в A1; filename/mime/size/tag — следующий этап.
Fuzzy, proximity, boost, interval functions и min-should-match пока явно отклоняются.

## Даты и ограничения

Планируется `--timezone <zone>`, default — system IANA timezone, сообщённый в JSON.
ISO day означает календарный день. Inclusive верхняя day boundary включает весь день,
exclusive — исключает его. В DST нельзя прибавлять 24 часа для вычисления следующего midnight.
Regex работает с термами text либо целым keyword body; JS flags и lookaround не являются Lucene.
Исполнение ограничивается query/depth/automaton/expansion/candidate/byte/time budgets.

## Машинный контракт

CLI и MCP вызывают один service с typed AST и registry version. Ranking не расширяет Boolean
множество. Account permissions задаются отдельно от query. Неизвестные поля и неподдержанные
операторы дают structured validation_error с позицией; exhaustion не выдаётся как полный ответ.
Полнота охвата, готовность индекса и pagination сообщаются отдельно, в том числе при нуле hits.

[Техническая спецификация](query-language-spec.md)
