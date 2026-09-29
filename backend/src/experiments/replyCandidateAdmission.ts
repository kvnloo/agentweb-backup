export interface ReplyCandidate {
  id: string;
  text?: string | null;
  url?: string | null;
  suggestedReply?: string | null;
}

export function admitReplyCandidates(
  candidates: ReplyCandidate[],
  seenIds: Iterable<string>,
  limit = 5,
): ReplyCandidate[] {
  const seen = new Set(seenIds);
  const admitted: ReplyCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    if (!candidate.text?.trim() || !candidate.url?.trim() || !candidate.suggestedReply?.trim()) continue;
    admitted.push(candidate);
    if (admitted.length >= limit) break;
  }
  return admitted;
}
