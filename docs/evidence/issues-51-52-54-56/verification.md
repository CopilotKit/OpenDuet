# Task and first-day reliability verification

Checked on 2026-10-23 against the isolated fake-data stack at localhost:3041 / localhost:3141, using Bun 1.4.3. Live tasks used synthetic instructions with no external-data tools.

## Implemented

- Final spoken question or accepted reply chips derive Needs input. Quoted drafts and list-only questions do not. The persisted flag distinguishes explicit false from older rows that need tail inference.
- Task replies are server work items with stable message IDs, idempotent offers, per-task FIFO claiming, leases, restart recovery, and a durable Queued display. A live lease blocks other replies even when an older insert becomes visible late.
- Busy state is owned per run. A refused parallel turn can release only its own claim. The browser and runtime await each start announcement before its corresponding release.
- Successful task replies acknowledge only completed question IDs captured before their turn. New questions and approval requests remain intact.
- Folded task reports disable transcript auto-scroll and reset the viewport to zero; expanded conversations retain follow-to-bottom.
- First-day conversation lookup is serialized. The first-day claim and greeting work item commit together. The browser opens the conversation; the server delivers the greeting, including after the claiming browser disappears.

## Automated evidence

- 118 passing server/toolkit tests across the task threads, work queue, channel activity, busy runner, task turn, thread lock and turn-settle suites.
- 41 passing UI tests across first-day and task-thread suites, including server queue display and folded report scroll position.
- One additional passing PostgreSQL regression: snapshot a prior question, answer it successfully, retain a new question raised during the reply; Working while answering, then Needs input for the new question.
- One additional passing PostgreSQL regression: an older reply committed after a newer finished turn still keeps the task Working.
- Server production typecheck and test typecheck passed before the final two narrow regressions; final whole-tree typecheck is delegated to the parent verification pass/CI.
- Own-source lint and `git diff --check` pass.

The first-day tests concurrently start two requests, assert one conversation and one durable greeting row, discard the claiming browser result, then create a new worker and assert one greeting delivery across two sweeps. The queue integration sends two HTTP replies behind a held initial turn, recreates the worker, checks ordered delivery with original IDs and verifies idempotent re-posting. A delayed older insertion is separately tested against a live newer lease.

## Live evidence

`live-synthetic-task.log` records task `9248fd3e-e786-411b-9a3c-b2510353c0d8`:

1. The question produced Needs input.
2. Sending the first reply produced Working.
3. A second tab sent another reply and displayed Queued (`two-tabs-queued.png`). Both tabs were closed; the second was also reloaded before closure.
4. The server completed both replies in order. Reopening showed both user messages and both answers, including the second requested phrase “Friday review confirmed”. The task ended Ready for review.
5. Opening from the Tasks link and reloading retained the top report with its header and folded conversation.

Screenshots capture the question state, Queued state, reopened report and delivered replies. Parent verification owns the full onboarding finish recording and broader checks.

The final Chat-link probe created `Synthetic review checklist` from Chat, followed the real `/tasks/be60fd44-609b-411c-a8c2-471ad72e3a06` link, and reloaded that route. Both opens kept the title/header at y=12px with Show conversation folded. `chat-link-top.log`, `chat-task-link.png`, `task-from-chat-top.png`, and `task-from-chat-reload-top.png` record this path. `task-ready-top.png` was refreshed after the report data settled and shows the ordered decisions and updates.

An independent read-only review found no actionable issue in the final first-day transaction, ordered busy lifecycle or question acknowledgement changes. The final late-commit status regression and final production changes are frozen for the parent CI run.
