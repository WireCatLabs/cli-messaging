import json
from pathlib import Path

root = Path(__file__).parent
original = json.loads((root / 'corpus.json').read_text())
queries, chats, messages = [], [], []

# Questions state the task, never the labelled answer. Original keyword queries remain unchanged.
questions = [
    ('aurora', 'aurora rollout rollback', 'What rollback decision was agreed for the Aurora rollout?', 'What should we do to roll back the Aurora rollout?'),
    ('cedar', 'cedar backup retention', 'What retention policy was agreed for Cedar backups?', 'How long should Cedar backup snapshots be kept?'),
    ('север', 'север сертификат обновление', 'Какое решение принято по обновлению сертификата Север?', 'Что известно о новом сертификате Север и сроке его действия?'),
    ('lumen', 'lumen invoice refund', 'What refund was approved for the Lumen invoice?', 'What should be returned to the payer of the Lumen invoice?'),
]
for family, anchors, decision, question in questions:
    relevant = next(q['relevant'] for q in original['queries'] if q['id'] == f'{family}-words')
    for category, text in [('decision', decision), ('question', question)]:
        queries.append(dict(id=f'{family}-question-{category}', split='dev', family=family, category=category, retrieval=anchors, text=text, relevant=relevant))
    text = f'Which independent auditor signed off on {anchors}?' if family != 'север' else 'Какой независимый аудитор подписал обновление сертификата Север?'
    queries.append(dict(id=f'{family}-question-no-answer', split='dev', family=family, category='no-answer', retrieval=anchors, text=text, relevant={}))

fresh = [
    ('cobalt', 'cobalt failover routing', 'Cobalt failover routing approved: route traffic to the west pool and hold the east pool offline.', 'Cobalt failover routing owner is Lea; the approved change is documented.', 'What failover routing was approved for Cobalt?', 'Where should Cobalt traffic go after failover?'),
    ('birch', 'birch export encryption', 'Birch export encryption policy: encrypt every export with a per-recipient key before sending it.', 'Birch export encryption owner is Arun; the agreed policy is documented.', 'What export encryption policy was agreed for Birch?', 'How should Birch exports be encrypted before they are sent?'),
    ('спектр', 'спектр очередь лимит', 'Спектр очередь лимит согласован: принимать не более 120 задач, остальные отправлять в резервную очередь.', 'Спектр очередь лимит подтвержден, владелец Даша.', 'Какой лимит очереди согласован для Спектр?', 'Сколько задач принимает очередь Спектр и куда отправлять остальные?'),
    ('nova', 'nova access expiry', 'Nova access expiry policy: expire temporary access after 48 hours and require a new approval to extend it.', 'Nova access expiry owner is Bo; the agreed policy is documented.', 'What access expiry policy was agreed for Nova?', 'When does Nova temporary access expire and how can it be extended?'),
]
mid = 70000
for i, (family, anchors, answer, support, decision, question) in enumerate(fresh, 201):
    cid = str(i)
    chats.append(dict(id=cid, title=f'Synthetic {family} decisions'))
    relevant = {}
    for grade, text in [(2, answer), (1, support)]:
        mid += 1
        messages.append(dict(id=str(mid), chatId=cid, senderId='800', timestamp='2026-10-05T12:00:00.000Z', text=text))
        relevant[str(mid)] = grade
    for j in range(150):
        text = [f'{anchors}: put this item on the agenda. No agreement was reached.',
                f'{anchors}: rejected suggestion copied from a draft, awaiting a decision.',
                f'{anchors}: empty form awaiting the actual policy.',
                f'Checking whether the team discussed {anchors}. This is a question, not a confirmed decision.',
                f'{family} keyword list: {anchors}; no instruction is recorded.'][j % 5]
        mid += 1
        messages.append(dict(id=str(mid), chatId=cid, senderId='801', timestamp='2026-10-06T12:00:00.000Z', text=f'{text} Item {j}.'))
    for category, text in [('decision', decision), ('question', question)]:
        queries.append(dict(id=f'{family}-question-{category}', split='test', family=family, category=category, retrieval=anchors, text=text, relevant=dict(relevant)))
    text = f'Which independent auditor signed off on {anchors}?' if family != 'спектр' else 'Какой независимый аудитор подписал лимит очереди Спектр?'
    queries.append(dict(id=f'{family}-question-no-answer', split='test', family=family, category='no-answer', retrieval=anchors, text=text, relevant={}))

(root / 'questions.json').write_text(json.dumps(dict(chats=chats, messages=messages, queries=queries), ensure_ascii=False, indent=2) + '\n')
