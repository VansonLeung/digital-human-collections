import type { MemoryCandidate } from '@digital-human/shared';

/** Conservative fallback for an explicit first-person preference, not inferred biography. */
export function explicitMiraPreference(
  reply: string,
  counterpart = '',
): MemoryCandidate | undefined {
  for (const sentence of reply.split(/(?<=[.。！？!?；;\n])/u)) {
    const quote = sentence
      .trim()
      .match(
        /^(?:我(?:比較|比较|真係|平時|平时|通常|都|最|一向)?(?:鍾意|鐘意|喜歡|喜欢|偏愛|偏爱|唔鍾意|不喜歡|不喜欢|討厭|讨厌)|I (?:really )?(?:prefer|like|enjoy|love|dislike|hate))\s*[^.,，。！？!?；;\n]{1,100}/iu,
      )?.[0]
      .trim();
    if (
      !quote ||
      /[?？]/u.test(sentence) ||
      /(?:如果|假如|嘅話|的话|你|\b(?:if|you)\b)/iu.test(quote) ||
      counterpart.includes(quote)
    )
      continue;
    const key = /(?:飲|喝|茶|咖啡|drink|coffee|tea|juice)/iu.test(quote)
      ? 'preferred_drink'
      : /(?:食|吃|甜品|food|dessert|eat)/iu.test(quote)
        ? 'preferred_food'
        : /(?:行山|散步|跑步|hiking|walking|running)/iu.test(quote)
          ? 'preferred_activity'
          : `preference_${quote
              .normalize('NFKC')
              .toLocaleLowerCase()
              .replace(/[^\p{L}\p{N}]/gu, '')
              .slice(0, 60)}`;
    return { owner: 'mira', category: 'preferences', key, value: quote, quote };
  }
}
