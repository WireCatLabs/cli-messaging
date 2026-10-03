# Member-count diagnostic

Approved parity repair continuation. Claim fix/member-count-diagnostic (existing MAX CLI-62).
Source: chats-command show compares members.length with participantsCount and labels the list
cut short. MAX client excludes the viewer in #participantsOf; shared storedMembers does too.
The difference alone cannot prove truncation or that the viewer is currently a member.

Report the actual listed count and provider total, explaining that the list can omit this account
or be partial. Do not fabricate self membership, add a person or change JSON/counts. Tests cover
2listed/3total, genuinely smaller lists, equal totals and unknown totals. Gates, PR/release and
consumer pins as needed; no protocol calls, schema/store changes or live operations.
