# Clarifications and working assumptions

Recorded on 13 October 2026.

## Answered

| Question raised | Your answer | Consequence |
| --- | --- | --- |
| Stylized 3D, Live2D, or photorealistic first? | “I prefer 1 and 2” | Shortlist both stylized 3D and Live2D. Recommend a VRM first; retain a concrete Live2D comparison. |
| Entirely local or paid cloud avatar service? | “Entirely local; free sample assets first” | Local browser rendering and local speech; no paid service or remote renderer dependency. |
| Languages and intended use? | “English, Mandarin, Cantonese” | Evaluate all three languages separately. Commercial deployment intent was not specified. |

## Remaining decisions

These do not prevent the research or sample downloads:

1. **Default identity and visual style:** Constraint Twist/Seed-san for stylized 3D, or Haru/Ren Foster for Live2D? The downloaded samples make this a visual comparison rather than a hypothetical choice.
2. **Speech fidelity:** is convincing opening/closing sufficient for an early prototype, or should closed-lip consonants and rounded vowels be clearly distinguishable? I recommend testing vowel/consonant cues before accepting volume-only motion.
3. **Use and distribution:** private evaluation, public noncommercial demo, or commercial assistant? Live2D character rights and SDK release terms are separate. Preserve the VRM per-model settings when making a public browser build.
4. **Voice identity:** one consistent voice across languages, or different native-language presets? English and Chinese Qwen presets can be compared now; Cantonese remains a separate voice-quality gate.
5. **Offline scope:** does “entirely local” also require the LLM to run on this Mac? The avatar proposal is local, but the current application allows a configured LLM endpoint. A local LLM would add unified-memory and compute contention to the benchmark.

## Assumptions used in the recommendation

One visible avatar, short replies, upper-body framing, desktop browser first, and no webcam face capture. Use integrated Apple graphics and local CPU processing. Keep the existing speech HTTP contracts and compare one representative of each rendering family before implementing multiple production backends.

The collected characters retain their upstream identities. A display name, conversational role, voice choice, and visual model are separate settings; acquiring a visual model does not provide a trained conversational personality or a matching licensed voice.
