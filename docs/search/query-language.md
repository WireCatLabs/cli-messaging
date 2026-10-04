# Поиск в локальном архиве

Lucene profile v1 доступен через shared services, CLI и MCP; потребителям нужна
версия cli-messaging с этим профилем. Синтаксис основан на Apache Lucene 9.12.3
StandardSyntaxParser и PrecedenceQueryParser, default AND, default field `text`.
Это ограниченный профиль языка, а не полный Lucene search engine.

Этот профиль — для `messages search` и `messages_search` MCP. `bot messages search`
сохраняет legacy discovery; строгий поиск общего архива выбирает bot accounts через `in:bots`.

Поиск читает только локальную БД, без сети и отметок о прочтении. Пустой ответ означает
«не найдено в выбранном архиве». Проверяйте `coverage`, `completeness` и готовность индекса.
Если word index не готов, выполните `store migrate`: строгий поиск не переходит на substring.

## Быстрый старт

Примеры ниже исполняются тестами через реальные shared CLI и MCP на
[synthetic fixture](recipes.json). На своём архиве подставьте собственные имена чатов/авторов;
показанные ids относятся только к fixture. Для машинного ответа добавьте `--json`.

<!-- recipes: generated -->

### Точное слово

```sh
tg messages search 'invoice' --timezone UTC
```

На synthetic fixture: ids 101, 102, 106. В MAX замените первый аргумент `tg` на `max`.

### Фраза

```sh
tg messages search '"invoice paid"' --timezone UTC
```

На synthetic fixture: ids 101, 106. В MAX замените первый аргумент `tg` на `max`.

### Группа авторов

```sh
tg messages search 'from:("Alice Synthetic" OR "Bob Synthetic") AND invoice' --timezone UTC
```

На synthetic fixture: ids 101, 102, 106. В MAX замените первый аргумент `tg` на `max`.

### Чат по имени

```sh
tg messages search 'chat:"Work fixture" AND invoice' --timezone UTC
```

На synthetic fixture: ids 101, 102, 106. В MAX замените первый аргумент `tg` на `max`.

### Диапазон дат

```sh
tg messages search 'invoice date:[2026-01-20 TO 2026-01-22}' --timezone UTC
```

На synthetic fixture: ids 101, 102. В MAX замените первый аргумент `tg` на `max`.

### Личная переписка

```sh
tg messages search 'passport kind:private' --timezone UTC
```

На synthetic fixture: ids 103. В MAX замените первый аргумент `tg` на `max`.

### Кандидат secret в Избранном

```sh
tg messages search 'preset:secret kind:saved' --timezone UTC
```

На synthetic fixture: ids 104. В MAX замените первый аргумент `tg` на `max`.

### Regex по терму

```sh
tg messages search 'text:/pass(port)?/ kind:private' --timezone UTC
```

На synthetic fixture: ids 103. В MAX замените первый аргумент `tg` на `max`.

### Regex по полному тексту

```sh
tg messages search 'body:/.*invoice.*/' --timezone UTC
```

На synthetic fixture: ids 101, 102, 106. В MAX замените первый аргумент `tg` на `max`.

### Сообщение только с файлом

```sh
tg messages search 'has:file' --timezone UTC
```

На synthetic fixture: ids 105, 108. В MAX замените первый аргумент `tg` на `max`.

### Файл по имени

```sh
tg messages search 'filename:*.pdf' --timezone UTC
```

На synthetic fixture: ids 105, 108. В MAX замените первый аргумент `tg` на `max`.

### Имя файла без учёта регистра и ё

```sh
tg messages search 'filename:отчет.pdf' --timezone UTC
```

На synthetic fixture: ids 108. В MAX замените первый аргумент `tg` на `max`.

### Файл больше 1 МБ

```sh
tg messages search 'size>1MB' --timezone UTC
```

На synthetic fixture: ids 105. В MAX замените первый аргумент `tg` на `max`.

### Ссылка на сайт

```sh
tg messages search 'has:link AND "example.org"' --timezone UTC
```

На synthetic fixture: ids 107. В MAX замените первый аргумент `tg` на `max`.

### Метка на сообщении или авторе

```sh
tg messages search 'tag:work invoice' --timezone UTC
```

На synthetic fixture: ids 102, 106. В MAX замените первый аргумент `tg` на `max`.

### Метка на чате

```sh
tg messages search 'tag:family' --timezone UTC
```

На synthetic fixture: ids 103, 108. В MAX замените первый аргумент `tg` на `max`.

### Без метки

```sh
tg messages search 'invoice NOT tag:work' --timezone UTC
```

На synthetic fixture: ids 101. В MAX замените первый аргумент `tg` на `max`.

<!-- recipes: end -->

## Операторы

<!-- operators: generated -->

| Оператор | Пример | Семантика / поддержка |
|---|---|---|
| term | `invoice` | Точное совпадение анализированного текста; без автоматического prefix |
| phrase | `"invoice paid"` | Последовательность анализированных слов |
| implicit AND | `invoice paid` | Оба clauses обязательны; adjacency группируется по upstream grammar |
| AND / && | `alpha AND beta` | Оба условия обязательны |
| OR / \|\| | `alpha OR beta` | Любой optional clause, если нет required clause |
| NOT / ! / - | `alpha NOT beta` | Исключить beta; чистое отрицание не выбирает весь архив |
| + | `+alpha OR beta` | alpha обязателен, beta optional |
| group | `(alpha OR beta) gamma` | Скобки фиксируют grouping |
| field group | `from:(alice OR bob)` | Поле наследуется внутри группы |
| field equality | `kind=group` | Стандартный синоним записи kind:group |
| range | `date:[2026-01-01 TO 2026-02-01}` | Inclusive [ ], exclusive { }, смешанные границы и * |
| comparison | `date>=2026-01-01` | Стандартный typed open range |
| wildcard | `text:invo*` | Полный term; * — любое число символов, ? — один |
| regex | `text:/pass(port)?/` | Полный term; bounded subset Lucene RegExp |
| fuzzy / proximity | `invoice~1` | unsupported_operator; используйте legacy discovery либо точные слова |
| boost / minimum / intervals | `invoice^2` | unsupported_operator |

<!-- operators: end -->

Явный AND связывает сильнее OR. Однако `alpha OR beta gamma` согласно pinned grammar
означает `(alpha OR beta) AND gamma`, а `alpha OR beta AND gamma` — `alpha OR (beta AND gamma)`.
Нижний регистр `and/or/not` — обычный текст. Pure-negative query не даёт совпадений;
для исключения укажите положительное условие, например `kind:group NOT preset:secret`.

Ranking не меняет Boolean множество. Когда все ветви требуют text, используется BM25
по обязательному word-index кандидату; иначе — стабильный newest order. `--newest`
всегда сортирует по времени. Равные scores/time разрешаются account-qualified ids.

## Поля

Имена полей case-sensitive. Повтор поля — обычный Boolean AST. Неизвестное поле, значение
enum или unsupported сочетание дают ошибку, а не пустой ответ. Unknown name автора/чата
не разрешается через сеть. Числовой id может обозначать чат, история которого ещё не сохранена.

<!-- fields: generated -->

| Поле | Тип | Значения / нормализация | Пример | Поддержка |
|---|---|---|---|---|
| `text` | tokens | NFKD/marks/NFC/lowercase v1 | `invoice` | term, phrase, wildcard, regex |
| `body` | keyword | raw, case-sensitive | `body:/.*invoice.*/` | term, phrase, wildcard, regex |
| `from` | person | account-scoped resolution | `from:"Alice Synthetic"` | term, phrase |
| `chat` | chat | account-scoped resolution | `chat:"Work fixture"` | term, phrase |
| `date` | timestamp | ISO/calendar timezone; today, yesterday, 30m/2h/7d ago | `date:[2026-01-01 TO 2026-02-01}` | term, phrase, range |
| `kind` | enum | private, saved, bot, service, group, channel, unknown | `kind:private` | term, phrase |
| `has` | enum | attachment, link, file, photo, image, video, audio, voice, sticker, contact, location, poll | `has:file` | term, phrase |
| `topic` | id | string id, one chat required | `chat:7 AND topic:42` | term, phrase |
| `in` | source | lowercase provider/account class | `in:bots` | term, phrase |
| `preset` | enum | password, code, api-key, secret, card, bank, passport, phone, email, telegram-link, url, contact, location | `preset:secret` | term, phrase |
| `filename` | keyword | NFKD/marks/NFC/lowercase v1, whole name | `filename:*.pdf` | term, phrase, wildcard, regex |
| `mime` | keyword | lowercase; a value without / matches the first part; only where the messenger reports a type | `mime:"application/pdf" OR mime:image` | term, phrase, wildcard |
| `size` | bytes | bytes; KB/MB/GB are 1024-based | `size>10MB` | term, phrase, range |
| `tag` | local-tag | lowercase a-z, 0-9 and -, 1-32 characters | `tag:work` | term, phrase |

<!-- fields: end -->

`kind:private` сохраняет mapping старого `dialog`. Подтверждённый `providerMetadata.peerKind`
различает bot/service; существующий `providerMetadata.isBot` также определяет bot. старые записи не переклассифицируются по имени. `kind:bot` — peer,
`in:bots` — аккаунты Bot API. Unknown peers остаются в unfiltered search.
`topic` требует одного обязательного `chat` или `--chat`, чтобы одинаковые thread ids не смешивались.
`filename`, `mime` и `size` ищут по файлам сообщения: подходит сообщение, у которого подходит хотя бы
один файл, текст не нужен. `filename` сравнивает имя целиком без учёта регистра и ударений — часть
имени ищут через `filename:*договор*`. `size` берёт байты или KB/MB/GB (по 1024): `size>10MB`,
`size:[1KB TO 300KB]`. `mime` работает, только где мессенджер сообщает тип файла: Telegram сообщает,
MAX — нет, там ищите по расширению (`filename:*.pdf`). `/` в запросе начинает regex, поэтому полный
тип пишется в кавычках (`mime:"application/pdf"`), а `mime:image` находит любые картинки.
Ссылку на сайт находит фраза: `has:link AND "github.com"`; ссылка только карточкой предпросмотра
тоже считается. `tag:work` находит сообщение с меткой `work`, сообщение в чате с этой меткой и
сообщение от человека с этой меткой. Метки ставит владелец: `tags add work --chat <chat>`,
`--contact <person>` или `--message <id> --chat <chat>`; они живут только в локальном хранилище и
никуда не отправляются. Метка — 1–32 символа a–z, цифры и дефис, регистр не важен; `NOT tag:work`
точен.
`date` понимает и относительные даты: `date:today` и `date:yesterday` — календарный день в
`--timezone`; `date:7d` — с момента 7 дней назад (также `30m`, `2h`); `date>=7d` и
`date:[30d TO 7d}` — то же в сравнении и диапазоне. Отсчёт идёт от момента запроса.

Default scope — активный account. `in:` с положительным условием или `--source` явно выбирает
accounts провайдера/класса, включая `all`. Отрицательный `in:` не расширяет scope.
При заданном caller allow-list из `accounts` query не может его расширить;
`--source` и положительный `in:` тогда отвергаются. `--source` остаётся provider scope,
а не свежестью данных. Чат, запрещённый для общего поиска, читается лишь при обязательном
явном chat scope. Left/unknown history не объявляется полной автоматически.

## Regex: term и body

`text:/alpha/` совпадает с термом alpha внутри текста, но не с alphabeta.
`body:/alpha/` совпадает только с полным текстом alpha; для вхождения используйте
`body:/.*alpha.*/`. `body` — исходный keyword, case-sensitive; `text` содержит
normalized lowercase tokens. Regex syntax не подвергается целиком lowercase/normalization:
literal pattern должен соответствовать indexed term. Wildcard text literals нормализуются.

Поддержаны union `|`, concatenation, groups, `.`, classes/ranges/negation, `? * + {n} {n,m} {n,}`,
quoted literals, `#` (пустой язык), `@` (любая строка), Unicode code points и ASCII predefined
classes `\d \D \w \W \s \S`. Последние подтверждены **именно для Lucene 9.12.3** reference fixtures;
это не обещание всего JavaScript RegExp. `^` и `$` — literal characters, не JS anchors.
Intersection `&`, complement `~`, named automata и numeric intervals дают `unsupported_regex`;
negative predefined class внутри negated class также пока unsupported.
Lookaround, `(?:...)`, backreferences и `/i` suffix не являются поддержанными JS extensions.

Pattern исполняется NFA без backtracking, с work/state limits. Для text regex/wildcard
bounded vocabulary expansion использует безопасный literal prefix, если он доказан.
Слишком широкий dictionary pattern может быть отвергнут даже при узком chat scope;
укажите literal prefix либо используйте bounded `body` regex по одному чату.
Широкий body/preset scan выше бюджета отвергается до чтения всех тел.

## Escaping и Unicode

Двойные кавычки создают phrase/quoted field value, backslash экранирует следующий символ;
`\uXXXX` поддерживается в обычных terms/phrases. `text:hello\:world` не создаёт поле hello.
В shell оборачивайте query в одинарные кавычки. Regex escapes имеют отдельную Lucene semantics.

Текст нормализуется v1: NFKD → удалить marks → NFC → lowercase → control/whitespace folding.
Это игнорирует accents и сливает, например, `año/ano`, `мой/мои`; оригинальный body сохраняется.
Word index использует SQLite `unicode61 remove_diacritics 2`; пунктуация и emoji сами не образуют
индексированных слов. Анализированный literal term с несколькими tokens сопоставляется как
последовательность, а несколько отдельных query terms — как Boolean clauses.

## Даты и часовой пояс

`--timezone Europe/Madrid` или MCP `timezone` задаёт IANA zone; default — system IANA zone,
который возвращается в `query.timezone`. Date-only — начало календарного дня в этой zone.
Inclusive верхняя day boundary включает день целиком; exclusive его исключает.
Exclusive нижняя day boundary начинает со следующего дня. DST day может иметь 23 или 25 часов.
Дни, отсутствующие в zone, и неверные календарные даты отвергаются.

Quoted timestamp должен содержать секунды и offset: `"2026-01-01T10:00:00+02:00"`.
Для него inclusive/exclusive сравнивает точный UTC instant. `date:2026-01-01` означает весь день.
`7d` не является Lucene date math; legacy `after:7d` остаётся в legacy mode.

## Подсчёт: messages stats

`messages stats` считает то же, что нашёл бы `messages search` с тем же запросом, каждое сообщение один
раз: `--by chat` (по умолчанию) и `--by sender` — больше всего сверху, `--by day` и `--by hour` —
календарные дни и часы в `--timezone`, по порядку. Без запроса считаются все сохранённые сообщения.

```sh
tg messages stats invoice --by chat
tg messages stats 'from:me date>=30d' --by day --timezone Europe/Madrid
```

Если чаты сохранены не целиком, числа — нижняя граница; stderr говорит, сколько таких чатов.

## Presets

Detector сообщает **кандидата**, а не подтверждённую credential/действительный банковский документ.
Не используйте результат для автоматического удаления или передачи внешнему сервису.
Тела не копируются в отдельную secrets-таблицу и не попадают в diagnostics.

<!-- presets: generated -->

| Preset | Что считается кандидатом (version 1) |
|---|---|
| `password` | a password label followed by a value |
| `code` | a verification-code label and 4–8 digits |
| `api-key` | an API-key label and a value |
| `secret` | a password, secret, token or API-key label and a value |
| `card` | 13–19 digits with optional spaces or hyphens; no issuer verification |
| `bank` | an IBAN-shaped value; no bank or checksum verification |
| `passport` | a labelled passport value or Russian 4+6 digit shape |
| `phone` | a plus-prefixed 8–15 digit international-phone shape |
| `email` | an email-address shape |
| `telegram-link` | a t.me or telegram.me URL |
| `url` | an HTTP(S) URL |
| `contact` | a contact attachment or email/phone candidate |
| `location` | a location attachment or geo: URI |

<!-- presets: end -->

Правила locale-dependent; card/IBAN/passport shapes могут давать false positives.
`money/date/address/question` пока не являются presets. Каждый supported preset versioned;
`contact/location` также находят соответствующие attachments без текста.

## Ограничения и ошибки

<!-- limits: generated -->

| Ограничение | Значение |
|---|---|
| `bytes` | 8192 |
| `depth` | 32 |
| `nodes` | 256 |
| `pattern` | 1024 |
| `states` | 10000 |
| `expansions` | 10000 |
| `candidates` | 50000 |
| `bodyBytes` | 8388608 |
| `milliseconds` | 2000 |
| `work` | 10000000 |

<!-- limits: end -->

`query_limit` — reason внутри `validation_error`, с `budget` и `complete:false`;
сузьте чат/дату/pattern. Timeout/abort освобождает worker и timer. Предел времени проверяется
между синхронными SQLite calls и bounded batches; уже выполняющийся SQLite statement не прерывается.
NFA work budget ограничивает один match; legacy JS worker принудительно завершается на deadline.
Query page: 1–1000 results, context: прежняя CLI/MCP модель. SQL и FTS получают bound values.

Syntax/field/operator errors несут UTF-16 span `[start,end)`, reason и guide/alternative;
CLI печатает позицию с единицы. `index_not_ready` требует `store migrate`.
`unsupported_field` отличается от `unknown_field`; incomplete archive — состояние охвата, не syntax error.

## Миграция legacy

`messages search --language legacy 'from:alice after:7d invoice -draft'` сохраняет старый parser
и discovery chain. Standard default строгий: нулевой результат не заменяется похожими словами.
`--regex` явно выбирает отдельный legacy JS `iu` full-body mode; `--regex --language lucene` — ошибка.
Legacy regex теперь также имеет row/byte/time budgets; прежний бесконечный scan не сохраняется.

| Legacy | Standard |
|---|---|
| `alpha OR beta gamma` | `(alpha OR beta) AND gamma` — тот же grouping, сделанный явным |
| `after:2026-01-01` | `date:[2026-01-01 TO *]`, с выбранной zone |
| `before:2026-02-01` | `date:[* TO 2026-02-01}` |
| `after:7d` | Exact quoted timestamp range; preview фиксирует старый instant |
| Prefix/discovery автоматически | `text:invo*` явно; typo — `--language legacy` |
| `--regex 'invoice\\s+\\d+'` | Не alias term regex; keep legacy либо отдельно проверяйте body pattern |

Shared `migrateLegacyQuery` — pure preview, без записи saved query и без новой команды.
Он сохраняет legacy grouping/instants, закрывает ранее tolerated quote с предупреждением,
но не обещает сохранить discovery results. SavedQuery model хранит language/version;
репозиторий saved queries и миграция сохранённых записей — следующий этап.

## Машинный контракт и охват

CLI/MCP возвращают `{ items, page, limit, hasMore, corrections, completeness, wordsReady, query, coverage }`.
Strict `corrections` пуст; version/fieldsVersion/presetVersion/timezone/order описывают execution.
`coverage` сообщает accounts/chat/coveredChats, complete/partial/unknown, lastSyncedAt и inventoryComplete.
Полнота explicit chat выводится из существующих ranges/history-start markers, даже при hits=0.

- `completeness[].fetchedAt` — когда `store fetch` последний раз прочитал самую новую страницу чата; `null`,
  если ни разу. Чтение истории другими командами и live-сообщения его не двигают.
- `lastSyncedAt` — самый старый `fetchedAt` среди чатов охвата; `null`, если хотя бы один чат охвата ни разу
  не скачивался `store fetch`. Один свежий чат не говорит за весь охват.
- `inventoryComplete` — `true`, когда каждый account охвата хотя бы раз передал store полный список чатов
  (первая страница списка без `hasMore`). Это знание «когда-то», а не «сейчас»: чат, появившийся позже,
  store увидит только при следующем списке. Store до этой версии отвечает `false`/`null`, пока не получит
  список чатов и `store fetch`.
- `wordsReady` — реальное состояние word index для любого запроса. Запрос со словами при `false` даёт
  `index_not_ready`; запрос только по метаданным (`has:file`, `kind:`) работает и честно отвечает `false`.
Pagination `hasMore` не означает полноту сетевого архива.

MCP принимает `text` или versioned `ast`, не оба; текст и structured input проходят один validator.
AST: `{version:1,language:"lucene-v1",root:...}`; Boolean clauses имеют must/should/mustNot occurrences.
Raw SQL, regexp flags или authority allow-list в AST не принимаются как executable instructions.
Low-level `searchStore` и `MessagesService.search` без language сохраняют старую discovery semantics
для существующих callers; CLI и MCP явно выбирают standard default. Для scripted stable contract указывайте language явно.
Remote Telegram/MAX search не реализуется этим профилем: B получает AST/registry contract;
remote unsupported operators требуют явного отказа или bounded local postfilter с видимым охватом.

[Техническая спецификация](query-language-spec.md)
