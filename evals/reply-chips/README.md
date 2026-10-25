# Reply chips eval

Run against a local OpenDuet stack connected to Fake Google:

```sh
OPENDUET_APP=http://localhost:3041 OPENDUET_FAKE_MAILBOX=1 bun evals/reply-chips/run.ts
```

Ten natural choice questions, each in a fresh conversation. Passes with 2–3 short chips on at least seven turns and zero collapsed answers. A turn qualifies only when every label has 1–3 whitespace-separated words and at most 24 characters after trimming; blank labels fail. The [label helper](../../openbot/scripts/evals/reply-chips.ts) combines the [prompt's word limit](../../openbot/examples/openduet/agents.yaml) with the [reply tool's character limit](../../openbot/server/src/openduet/replies.ts), using the tool's UTF-16 string-length convention. The runner exits nonzero on failure. Once every question has a completed answer, it saves each turn's label qualification and answer check beside it. Never use a real mailbox.

Answer preservation uses the [shared structural rubric](../../openbot/scripts/evals/reply-answer.ts), with no minimum word count. Every turn, including turns without chips, must contain at least one non-question sentence with a subject/predicate cue (such as “Double-wall is safer”) or an instruction with a complement (such as “Use double-wall for Sam's mugs”). Question-only replies, follow-up invitations, common filler, and exact chip-label echoes do not count. Sentences and bubbles are checked separately, so a follow-up question does not hide a useful answer.

This is a conservative English heuristic for these choice questions, not a semantic quality score. Its explicit verb cues cannot recognize every valid answer; terse fragments such as “Rosa first” and unrecognized constructions fail for review. Conversely, a grammatical but irrelevant or false statement can pass. Review the saved prose for meaning and relevance, and manually review failures before treating them as confirmed answer collapse. Reports label this as a structural check; offline tests establish its behavior, not the quality of a model run.

Sampling uses the same completion contract as the [voice eval](../voice/README.md): every question needs a settled, nonempty answer before chip metrics are calculated. Paused, timed-out, stopped, empty, and browser/request failures captured while sampling a question fail the run and stop the batch. The batch attempts to close Chrome on success and failure; if cleanup succeeds, captured question-sampling failures are saved as structured diagnostic evidence. Reports use a new `results-<timestamp>.md` file. Errors during browser launch, context/page initialization, or cleanup are reported in the terminal and may leave no saved report.

The [original 2026-10-23 results](results-2026-10-23.md) remain unchanged prior-run evidence from before the shared completion and corrected scoring checks. The [separate offline rescore](rescore-2026-10-23.md) applies the actual label and answer helpers to those ten captured rows: 7/10 qualify and zero fail the structural answer check. It includes a manual review of meaning/relevance and the remaining evidence limits. This is not a new live eval and cannot establish that the old samples met today's completion contract; offline regression tests do not revalidate that recorded run.
