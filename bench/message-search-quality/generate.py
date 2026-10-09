import json
from pathlib import Path

# Fixed invented topics; the emitted corpus, rather than a random seed, is the evaluation input.
families = [
    ('dev', 'aurora', 'rollout', 'rollback', 'Aurora rollout rollback decision: disable the canary and restore build 17.', 'The Aurora rollout rollback owner is Mira; the decision is recorded above.', 'rolluot', 'roll', 'deployment reversal'),
    ('dev', 'cedar', 'backup', 'retention', 'Cedar backup retention decision: keep daily snapshots for 35 days.', 'The Cedar backup retention owner is Niko; the policy is recorded above.', 'bakcup', 'back', 'snapshot lifetime'),
    ('dev', 'север', 'сертификат', 'обновление', 'Север сертификат обновление: новый сертификат установлен, срок до 12 декабря.', 'Север сертификат обновление проверено, владелец Ира.', 'сертифкат', 'серти', 'продление TLS'),
    ('dev', 'lumen', 'invoice', 'refund', 'Lumen invoice refund approved: return 480 credits to the original payer.', 'The Lumen invoice refund owner is Eva; approval is recorded above.', 'invocie', 'invo', 'payment reimbursement'),
    ('test', 'harbor', 'release', 'freeze', 'Harbor release freeze decision: stop deployments until the database check passes.', 'The Harbor release freeze owner is Oren; the decision is recorded above.', 'relesae', 'rele', 'shipping pause'),
    ('test', 'maple', 'archive', 'restore', 'Maple archive restore decision: recover the March snapshot into a separate workspace.', 'The Maple archive restore owner is Ada; the decision is recorded above.', 'arhcive', 'arch', 'recover saved data'),
    ('test', 'вектор', 'миграция', 'отмена', 'Вектор миграция отмена: отключить задание и вернуть схему версии 8.', 'Вектор миграция отмена проверена, владелец Лев.', 'миграця', 'мигр', 'возврат прежней схемы'),
    ('test', 'prism', 'renewal', 'discount', 'Prism renewal discount approved: apply 15 percent to the annual contract.', 'The Prism renewal discount owner is Tess; approval is recorded above.', 'renweal', 'rene', 'subscription price reduction'),
]
messages, queries = [], []
chats = [{'id': str(i), 'title': f'Synthetic {name} decisions'} for i, (_, name, *_) in enumerate(families, 101)]
chats.append({'id': '999', 'title': 'Synthetic busy operations'})
next_id = 10000

def add(chat, sender, text, day=2):
    global next_id
    next_id += 1
    mid = str(next_id)
    messages.append(dict(id=mid, chatId=chat, senderId=sender, timestamp=f'2026-10-{day:02d}T12:00:00.000Z', text=text))
    return mid

for i, (split, name, word, action, answer, support, typo, prefix, meaning) in enumerate(families, 101):
    chat = str(i)
    a = add(chat, '700', answer)
    b = add(chat, '701', support)
    for j in range(300):
        templates = [
            f'{name} {word} {action}: agenda only; no decision yet. Thread {j}.',
            f'{name} {word} {action}? Please add this question to the meeting. Thread {j}.',
            f'Checklist heading: {name} {word} {action}. This empty template supplies no policy. Thread {j}.',
            f'{name} status digest. {word} is a document tag. {action} is a separate training exercise. No answer. Thread {j}.',
            f'Old {name} {word} {action} proposal rejected; do not treat this as the agreed decision. Thread {j}.',
        ]
        add('999' if j < 200 else chat, '702', templates[j % len(templates)], 3)
    variants = [
        ('words', f'{name} {word} {action}', None),
        ('typo', f'{name} {typo} {action}', None),
        ('beginnings', f'{name} {prefix} {action}', None),
        ('phrase', f'"{name} {word} {action}"', None),
        ('from', f'{name} {word} from:700', None),
        ('chat', f'{name} {word} chat:{chat}', None),
        ('date', f'{name} {word} date:2026-10-02', f'{name} {word} after:2026-10-02 before:2026-10-03'),
        ('and', f'{name} AND {word} AND {action}', f'{name} {word} {action}'),
        ('or', f'{name} {word} OR {action}', None),
        ('paraphrase', f'{name} {meaning}', None),
    ]
    for category, text, legacy in variants:
        relevant = {a: 2, b: 1}
        if category == 'from': relevant = {a: 2}
        queries.append(dict(id=f'{name}-{category}', split=split, category=category, intent=answer, lucene=text, legacy=legacy or text, relevant=relevant))
    for category, text in [('absent', f'{name} quantum unicorn'), ('near-miss', f'{name} {word} {action} purple')]:
        queries.append(dict(id=f'{name}-{category}', split=split, category=f'no-answer-{category}', intent='No message answers the requested combination.', lucene=text, legacy=text, relevant={}))

for j in range(200): add('999', '703', f'Unrelated lunch timetable and office stationery reminder {j}.', 4)
Path(__file__).with_name('corpus.json').write_text(json.dumps(dict(chats=chats, messages=messages, queries=queries), ensure_ascii=False, indent=2) + '\n')
