/**
 * The first `max` UTF-16 units of `text`, one fewer if the cut would split a surrogate pair (an emoji): LLM
 * providers' strict JSON parsers, DynamoDB and Meta reject a lone half (ENG-2638, ENG-2643).
 */
export function cutWithoutSplittingPair(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** ENG-2643: knowledge-base tool results longer than `max` are cut on a code-point boundary and marked. */
export function truncateToolContent(content: string, max = 5000): string {
  return content.length > max ? cutWithoutSplittingPair(content, max) + '\n\n[Content truncated]' : content;
}
