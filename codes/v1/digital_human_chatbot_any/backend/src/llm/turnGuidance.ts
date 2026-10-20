type ContextMessage = { role: 'user' | 'assistant'; content: string };
export type TurnKind = 'reply' | 'draft' | 'proactive';

// Most requests keep the conversation's existing tone. Randomness changes only
// an optional delivery cue; it never selects a topic, question, or emotion.
const styles = [
  {
    until: 0.65,
    name: 'natural',
    cue: 'Keep the existing conversational tone; do not force a stylistic flourish.',
  },
  {
    until: 0.8,
    name: 'warm',
    cue: 'If the context is casual, add a little warmth or appreciation connected to the last message.',
  },
  {
    until: 0.88,
    name: 'coy',
    cue: 'If the context welcomes flirting, add a small coy reaction connected to the last message.',
  },
  {
    until: 0.95,
    name: 'playful',
    cue: 'If the context is lighthearted, use a brief playful observation connected to the last message.',
  },
  {
    until: 1,
    name: 'straightforward',
    cue: 'Keep the wording especially simple and direct; no extra teasing is needed.',
  },
] as const;

function questions(text: string) {
  return (text.match(/[^.!?。！？\n]*[?？]/gu) ?? [])
    .map((question) => question.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

/** Punctuation and exact repeats are hints, not semantic judgments. The model
 * still checks the actual dialogue for requests, answers, and natural closure. */
export function turnGuidance(
  history: readonly ContextMessage[],
  kind: TurnKind,
  random: () => number = Math.random,
  getToKnowEachOther = false,
) {
  const counterpart = kind === 'draft' ? 'assistant' : 'user';
  const latest = history.at(-1);
  const latestQuestions = latest?.role === counterpart ? questions(latest.content) : [];
  const priorQuestions = new Set(
    history
      .slice(0, -1)
      .filter((message) => message.role === counterpart)
      .slice(-3)
      .flatMap((message) => questions(message.content)),
  );
  const repeatedQuestion = latestQuestions.some((question) => priorQuestions.has(question));
  const sample = random();
  const roll = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
  const style = getToKnowEachOther
    ? {
        name: 'attentive',
        cue: 'Notice what was actually shared and respond with understanding. No flourish, teasing or question is required.',
      }
    : (styles.find((style) => roll < style.until) ?? styles.at(-1)!);
  const focus =
    kind === 'proactive'
      ? 'check_pending_questions'
      : latestQuestions.length
        ? 'answer_latest_question'
        : 'respond_to_latest_message';

  return `CURRENT TURN GUIDANCE (request-only; do not include these labels in the output):
Turn kind: ${kind}.
${
  kind === 'draft'
    ? 'Current speaker: the user talking to Mira. Mira is the counterpart. Earlier user lines are yours; earlier Mira lines belong to her.'
    : 'Current speaker: Mira talking to the user. Earlier assistant lines are yours; earlier user lines belong to the counterpart.'
}
Keep ownership of experiences, feelings, actions, promises, and outcomes with the original speaker. Do not adopt the counterpart's statements as your own or reverse who did what when teasing.
Before returning, check the recent lines from both speakers: replace any unnecessary echo or recycled punchline with your own relevant contribution. Do not just exchange I/you (我/你), reverse a challenge, or add a curse to disguise repetition. Preserve an exact quote only when the request calls for it.
Conversation focus: ${focus}.
${
  kind === 'proactive'
    ? 'Review whether a user question or request remains unanswered. Address it first; silence does not mean the topic is finished. If Mira is waiting for an answer, do not ask the same question again.'
    : kind === 'draft'
      ? "Respond from the user's perspective to Mira's latest message. Answer her question first when possible; if personal information is unknown, acknowledge uncertainty while staying with it."
      : "Respond to the user's latest question or request first, before any banter or additional conversational opening."
}
Repeated question cue: ${repeatedQuestion ? 'an exact question recurs in recent messages; if it was already answered, acknowledge that answer and add something useful instead of restarting the same interrogation. Still address any unanswered or new part of the latest message.' : 'no exact repeat detected; still avoid paraphrasing a question that the conversation already answered.'}
These cues are conservative: questions without question marks and differently worded repeats still need to be understood from context.
Continue the current topic while anything important remains unanswered. A useful follow-up is welcome. Consider a fresh topic only at a natural stopping point, after the current question is addressed; topic length alone is not a reason to switch.
Optional style: ${style.name}. ${style.cue}
The style cue is secondary to relevance, answering the question, and the other person's tone. For factual, serious, or uncomfortable exchanges, use a direct or considerate delivery instead. It never requires a new topic or a question.
Use the required language and JSON format below; keep all guidance labels out of the generated dialogue.`;
}
