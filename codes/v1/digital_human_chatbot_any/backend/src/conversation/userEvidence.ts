/** Invitations, hypotheticals and questions do not establish biography or habits. */
export function isUserMemoryEvidence(quote: string, source: string) {
  if (!source.includes(quote)) return false;
  if (
    /(?:不如|下次|聽日|明天|假如|如果|假設|例如|let'?s|shall we|how about|next time|tomorrow|for example|\bif\b)/iu.test(
      quote,
    )
  )
    return false;
  if (/[?？]/u.test(quote)) return false;
  if (
    /[?？]/u.test(source) &&
    !/(?:我(?:平時|平时|通常|一向|比較|比较|都|最|真係)?(?:鍾意|鐘意|喜歡|喜欢|偏愛|係|是|叫|住|做|有|會|会|唔|不|討厭)|\bI (?:am|work|live|prefer|like|enjoy|have|usually|don't|do not)|my (?:name|job|hobby)|(?:平時|平时|通常|一向).*(?:會|会|揀|選|鍾意|喜歡))/iu.test(
      quote,
    )
  )
    return false;
  return true;
}
