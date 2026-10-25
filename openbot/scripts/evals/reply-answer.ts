const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

// Small, explicit cues for the English choice-question eval, not a general grammar parser.
const questionOrInvitation =
  /^(?:(?:so|then|and|or),?\s+)?(?:who|what|which|when|where|why|how|should|would|could|can|do|does|did|is|are|was|were|will|have|has|may|might|shall|want|(?:please\s+)?(?:let me know|(?:tell me|confirm) (?:if|whether|who|what|which|when|where|why|how)))\b/i;
const fillerOrOffer =
  /^(?:here (?:are|is)|these are (?:the|your)|(?:the|your) (?:choices?|options?) (?:are|is)|i (?:am (?:happy|ready|here|glad)|would be happy)|(?:i|we) (?:can|could) |(?:it|that|this) is (?:a (?:good|great) question|up to you)|(?:please )?(?:choose|pick|select) (?:one|either|any|whichever|whatever|an? (?:option|choice)|the (?:best|right|preferred))\b)/i;
const statement =
  /^.+\b(?:is|are|am|was|were|has|have|had|must|should|would|will|can|cannot|can't|won't|could|do|does|did|recommend|suggest|prefer)(?:n't)?\s+["'“‘]?[\p{L}\p{N}]/iu;
const instruction =
  /^(?:please\s+)?(?:don't\s+)?(?:use|choose|pick|prioritize|reply|handle|confirm|keep|propose|offer|wait|review|check|send|promise)\s+["'“‘]?[\p{L}\p{N}]/iu;

function label(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function onlyChipLabels(
  text: string,
  chipLabels: ReadonlySet<string>,
): boolean {
  const starts = [0];
  for (const separator of text.matchAll(/[\n,;]|\s+(?:or|and|&)\s+/gi)) {
    // A separator inside a label is not a list boundary. Keep each possible start
    // until the whole intervening label matches, including its own separators.
    if (
      starts.some((start) =>
        chipLabels.has(label(text.slice(start, separator.index))),
      )
    ) {
      starts.push(separator.index + separator[0].length);
    }
  }
  return starts.some((start) => chipLabels.has(label(text.slice(start))));
}

/**
 * A conservative structural check, not a semantic judge. Require a non-question clause with
 * a subject/predicate cue or an instruction with a complement, beyond exact chip-label echoes.
 * Unknown wording fails for review; passing says nothing about factual correctness or relevance.
 */
export function hasProseAnswer(
  bubbles: readonly string[],
  chips: readonly string[],
): boolean {
  const chipLabels = new Set(chips.map(label));
  const clauses: { text: string; raw: string }[] = [];
  for (const bubble of bubbles) {
    // Preserve boundaries: a question in one bubble must not consume an answer in another.
    const rawSegments = bubble
      .split(/(?<=\n)|\s+[|/]\s+/)
      .flatMap((line) =>
        Array.from(sentences.segment(line), ({ segment }) => segment),
      );
    // Keep raw label identity alongside the span and clause form without list decoration.
    const segments = rawSegments.map((segment) =>
      segment.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""),
    );
    for (let start = 0; start < segments.length; start++) {
      let text = segments[start].trim();
      let raw = rawSegments[start].trim();
      // Assemble a whole soft-wrapped clause before deciding whether it is an echo.
      // Sentence ends and blank lines still keep a following answer independent.
      while (
        /\S[^\n]*\n$/.test(segments[start]) &&
        !/[.!?？]["'”’)]*\s*$/.test(segments[start]) &&
        start + 1 < segments.length
      ) {
        // Retain line boundaries for complete chip-list identity until echo matching.
        text += `\n${segments[++start].trim()}`;
        raw += `\n${rawSegments[start].trim()}`;
      }
      clauses.push({ text, raw });
    }
  }
  for (let start = 0; start < clauses.length; start++) {
    // Complete chip echoes can span clauses or display bubbles. Match their full
    // identity before classifying any fragment; each clause keeps its own boundary.
    let span = "";
    let rawSpan = "";
    let echoEnd = -1;
    for (let end = start; chipLabels.size > 0 && end < clauses.length; end++) {
      span = `${span} ${clauses[end].text}`.trim();
      rawSpan = `${rawSpan} ${clauses[end].raw}`.trim();
      if (
        onlyChipLabels(rawSpan, chipLabels) ||
        onlyChipLabels(span, chipLabels)
      )
        echoEnd = end;
    }
    if (echoEnd >= start) {
      start = echoEnd;
      continue;
    }
    // Only prose classification flattens the already-assembled soft-wrapped clause.
    let text = clauses[start].text.replace(/\n/g, " ").trim();
    if (!text) continue;
    text = text.replace(/[‘’]/g, "'");
    if (/[?？]/.test(text) || onlyChipLabels(text, chipLabels)) continue;
    const clause = text
      .replace(/\bI'd\b/gi, "I would")
      .replace(/\bI'm\b/gi, "I am")
      .replace(/\b(it|that|there)'s\b/gi, "$1 is");
    if (questionOrInvitation.test(clause) || fillerOrOffer.test(clause)) {
      continue;
    }
    if (statement.test(clause) || instruction.test(clause)) return true;
  }
  return false;
}
