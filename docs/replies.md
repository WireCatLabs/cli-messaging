# Editing reply rules

Reply rules belong to one profile in its config directory, `<profile>.replies.json`.
`serve` applies enabled rules, within `replies.send`, recipient and rate limits. It still answers
only accounts named in `testers`. The editing commands never connect or send.

Create a disabled rule with every key written out, edit its template, then enable it:

```sh
max replies add after-hours
max replies edit after-hours --template 'Thanks, {firstName}, I will answer later.'
max replies edit after-hours --outside 09:00-19:00 --days mon-fri --timezone Europe/Madrid
max replies on after-hours
max replies off after-hours
```

The same commands work with `tg`. Rule ids contain lowercase letters, digits and hyphens.
`add` refuses duplicate ids. Enabled rules with a `reply` action need a nonempty template;
disabled and task-only rules can keep it empty. Enabling does not grant permission to send.

`edit` changes only flags you give it. Lists are comma-separated, replace the whole list,
and an empty string clears them. Chat and person ids remain strings.

| Fields | Options |
|---|---|
| Actions | `--do reply,task` |
| Chats | `--kinds dialog,group`, `--chats`, `--not-chats` |
| Conditions | `--words`, `--question` / `--no-question`, `--mentions-me` / `--no-mentions-me` |
| Senders | `--people`, `--not-people`, `--contacts-only` / `--no-contacts-only` |
| Reply | `--template`, `--model fill-only`, `--as-reply` / `--no-as-reply` |
| Limits | `--per-chat 1/12h`, `--per-person 1/1d` |
| Hours | `--outside`, `--days`, `--timezone`, `--no-hours` |

First setting hours requires the window, days and timezone together. Later edits may change just
one of them. `--no-hours` clears the window and cannot accompany its fields. The currently accepted
`may-reword` model mode does not reword yet; use `fill-only` for literal placeholder substitution.

`replies audience` shows the file-level audience. Its flags change only named fields:
`--reply all|listed`, `--allow-people`, `--allow-chats`, `--deny-people`, `--deny-chats`.
The lists use the same replacement and clearing rules. `deny` wins over `allow`.
With `listed` and an empty allow list nobody is answered; tasks can still open.
Warnings go to stderr, while `--json` writes only the result to stdout.

Every edit checks both the existing file and the proposed result before an atomic write.
Malformed files are refused without being overwritten. Reply state and testers stay untouched.
