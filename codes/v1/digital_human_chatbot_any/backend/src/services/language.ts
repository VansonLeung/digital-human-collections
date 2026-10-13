import type { Language, ReplyLanguage } from '@digital-human/shared';

// Resolve locally so language selection adds no model call before the answer.
// Formal Chinese alone cannot reliably identify a spoken dialect. Preserve an
// established Cantonese conversation; otherwise use Mandarin for generic Han text.
export function resolveLanguage(
  text: string,
  selection: ReplyLanguage,
  previous: Language = 'en',
): Language {
  if (selection !== 'auto') return selection;
  if (/[嘅係唔冇佢哋咗啲嚟喺畀俾咁乜咩嗰噉攞睇嘢瞓搵嘥餸嬲啱喎囉嘞㗎㖞]/u.test(text)) return 'yue';
  if (/\p{Script=Han}/u.test(text)) return previous === 'yue' ? 'yue' : 'zh';
  if (/[a-z]/i.test(text)) return 'en';
  return previous;
}

export function transcriptionLanguage(value: string | null | undefined): Language | undefined {
  const normalized = value?.toLowerCase().replace(/_/g, '-');
  if (['yue', 'cantonese', 'zh-hk'].includes(normalized ?? '')) return 'yue';
  if (['zh', 'chinese', 'mandarin', 'zh-cn', 'zh-tw'].includes(normalized ?? '')) return 'zh';
  if (['en', 'english'].includes(normalized ?? '')) return 'en';
}
