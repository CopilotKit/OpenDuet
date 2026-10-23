# Voice eval

Checks that OpenDuet talks like a chat on a phone, as the chat contract asks: a direct answer in one to three short sentences per bubble, at most three listed things, no notes on where it read something, and no going back over an earlier answer.

It asks two kinds of question on a running stack, each in a fresh conversation:

- **The prompt's own example questions, verbatim** (`examples/openduet/agents.yaml`). Their people and facts are in nobody's mailbox. The check is that the Bot answers what was asked ("No, nothing from Kenji.") and does not repeat the example's made-up facts. When the examples used the demo mailbox's own people, the Bot took the example for the answer and stopped answering that question.
- **Twelve everyday asks** against the seeded mailbox and calendar, with each reply's words, sentences per bubble, listed things, caveats and self-corrections.

## Running it

```sh
OPENDUET_APP=http://localhost:3066 bun evals/voice/run.ts
```

It needs the app and server running with Gmail connected (Fake Google is enough) and system Chrome. Results go to `results-<date>.md`.

## What the numbers mean

The model decides how long an answer is, so these numbers move from run to run. Treat a run as a regression check on the prompt, not as a measurement of the model.
