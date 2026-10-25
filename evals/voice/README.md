# Voice eval

Checks that OpenDuet talks like a chat on a phone, as the chat contract asks: a direct answer in one to three short sentences per bubble, at most three listed things, no notes on where it read something, and no going back over an earlier answer.

It asks two kinds of question on a running stack, each in a fresh conversation:

- **The prompt's own example questions, verbatim** ([openbot/examples/openduet/agents.yaml](../../openbot/examples/openduet/agents.yaml)). Their people and facts are in nobody's mailbox. The check is that the Bot answers what was asked ("No, nothing from Kenji.") and does not repeat the example's made-up facts. When the examples used the demo mailbox's own people, the Bot took the example for the answer and stopped answering that question.
- **Twelve everyday asks** against the seeded mailbox and calendar, with each reply's words, sentences per bubble, listed things, caveats and self-corrections.

## Running it

```sh
OPENDUET_APP=http://localhost:3066 bun evals/voice/run.ts
```

It needs the app and server running with Gmail connected (Fake Google is enough) and system Chrome. Reports use a new `results-<timestamp>.md` file. The command fails if the median exceeds 45 words, any everyday answer exceeds 80 words, or a prompt-example grounding check fails.

Both browser evals require the submitted turn to be idle, its full answer text to remain stable for three seconds, and at least one nonempty assistant bubble. An approval pause, stopped turn, timeout, empty answer, or browser/request error captured while sampling a question fails sampling before metrics are calculated. The batch stops at the failed question and attempts to close Chrome. If cleanup succeeds, the saved failure report includes the failure reason, elapsed time, and unattempted questions, plus the channel and last observed state/text when available. Errors during browser launch, context/page initialization, or cleanup are reported in the terminal and may leave no saved report.

`results-2026-10-23.md` is retained as prior-run evidence from before this completion check; it was not rerun or revalidated by the offline tests.

The bounded offline regression tests are in `openbot/app/tests/eval-chat-sampling.test.ts` and are discovered by the existing OpenBot CI suite. They use the production sampler with a controlled clock and the app's DOM markers; they do not run a model or a live stack.

## What the numbers mean

The model decides how long an answer is, so these numbers move from run to run. Treat a run as a regression check on the prompt, not as a measurement of the model.
