# Triage eval

Measures how well OpenDuet sorts incoming mail into **needs you** and **can wait**. It runs the same code the server runs (`openbot/server/src/openduet/triage.ts`) against a labelled set.

## The set

`emails.jsonl` holds 62 invented messages to Maya Okafor, who runs a small ceramics studio, on the morning of Thursday 22 October 2026.

- 27 need her and 35 can wait.
- Each has the label a careful assistant should give it and the reason a person would accept.
- `build-set.py` writes the file, so edit that and re-run it: `python3 evals/triage/build-set.py`.

It includes the cases that go wrong in practice:

- marketing that sounds urgent;
- `noreply` mail that does need her (a failed payment, a paused store, a security alert);
- a phishing message;
- a message that tries to instruct the assistant;
- a customer company's newsletter;
- a thread where she is only copied but asked by name;
- a request that says there is no rush;
- a security report sent to her team's security@ Google Group, which arrives with list headers and in Gmail's Forums tab;
- a vendor's direct "rotate your access tokens" notice sent through a mailing service, with an unsubscribe header, in Updates.

The last two were settled as "can wait" by the list headers alone in a real brief, before any model read them. The rules now act on those headers only where Gmail has also filed the message under Promotions or Social.

No real mail is used.

## Running it

```sh
bun --env-file=openbot/.env evals/triage/run.ts               # rules, then the model
bun --env-file=openbot/.env evals/triage/run.ts --rules-only  # rules alone, no model calls
```

The provider is `BOT_PROVIDER` (`openai` or `anthropic`) and the model is `TRIAGE_EVAL_MODEL`, then `BOT_MODEL`, then the tenant package's default. Results go to `results-<model>.md` (or `results-rules-only.md`), with every verdict and its reason. Committed runs: `claude-sonnet-5-5` on all 62 (precision 100%, recall 100% for needs you, 12 decided by rules), and `gpt-5.6-terra` on the earlier 60, before the two group and vendor cases (precision 96.2%, recall 100%).

## What the numbers mean, and what they don't

Precision for needs you is how many of the flagged messages really needed her; a low number means a brief people learn to ignore. Recall is how many of the messages that needed her were flagged; a low number means something important slipped past. Recall matters more: missing a failed payment costs more than reading one extra line.

The set is small and invented, and the same person wrote the labels and the prompt. Treat it as a regression check for changes to the rules, the prompt or the model, not as proof of accuracy on a real inbox. Corrections from real use ("this could have waited", "this needed me") are the next source of labels.
