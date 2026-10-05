/**
 * ENG-715: payload contract for the reply-guy and post-ideas riff containers.
 *
 * Pure and deterministic, matching applyOpeningAction (no LLM narration here):
 * - reply-guy shows up to 5 candidates, each with post text, an http(s) link and
 *   a suggested reply; incomplete candidates and repeats from the previous run
 *   are dropped.
 * - post-ideas shows news as raw material for angles and never drafted post copy.
 * - both degrade loudly with a plain message, never blank and never filler.
 */

export const REPLY_GUY_CANDIDATE_COUNT = 5;

export const CONTAINER_FETCH_FAILED_MESSAGE =
  'I could not fetch fresh material for this session. Nothing below is made up; you can still start the conversation and I will work from what you tell me.';

export interface ReplyCandidateInput {
  id?: unknown;
  postText?: unknown;
  url?: unknown;
  suggestedReply?: unknown;
}

export interface ReplyCandidate {
  id: string;
  postText: string;
  url: string;
  suggestedReply: string;
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const httpUrl = (v: unknown): string | undefined => {
  const s = nonEmpty(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : undefined;
  } catch {
    return undefined;
  }
};

export function selectReplyCandidates(
  raw: ReplyCandidateInput[],
  opts: { previousIds?: Iterable<string>; limit?: number } = {},
): ReplyCandidate[] {
  const seen = new Set<string>(opts.previousIds ?? []);
  const limit = opts.limit ?? REPLY_GUY_CANDIDATE_COUNT;
  const out: ReplyCandidate[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (out.length >= limit) break;
    const postText = nonEmpty(c?.postText);
    const url = httpUrl(c?.url);
    const suggestedReply = nonEmpty(c?.suggestedReply);
    if (!postText || !url || !suggestedReply) continue;
    const id = nonEmpty(c?.id) ?? url;
    // Identity is the ID *and* the URL: either one already seen means the same post.
    if (seen.has(id) || seen.has(url)) continue;
    seen.add(id);
    seen.add(url);
    out.push({ id, postText, url, suggestedReply });
  }
  return out;
}

export type ContainerFetch<T> = { ok: false } | { ok: true; candidates?: T[]; items?: T[] };

export function renderReplyGuyOpening(
  fetched: ContainerFetch<ReplyCandidateInput>,
  opts: { previousIds?: Iterable<string> } = {},
): string {
  if (!fetched.ok) return CONTAINER_FETCH_FAILED_MESSAGE;
  const picked = selectReplyCandidates(fetched.candidates ?? [], opts);
  if (picked.length === 0) return CONTAINER_FETCH_FAILED_MESSAGE;
  return picked
    .map((c, i) => `${i + 1}. ${c.postText}\n   ${c.url}\n   Suggested reply: ${c.suggestedReply}`)
    .join('\n\n');
}

export interface NewsItemInput {
  title?: unknown;
  url?: unknown;
  summary?: unknown;
}

const DRAFT_MARKERS: RegExp[] = [
  /\b(draft(ed)? (post|tweet)|tweet|post copy|caption)\s*:/i,
  /\b(here'?s my take|hot take|my take)\b/i,
  /\b(thoughts|what do you think|agree)\?/i,
  /(^|\s)#[a-z][\w-]*/i,
  /(^|\n)\s*1\/\s/,
  /👇|🚀|🔥|🧵/u,
];

/** True when text reads like a ready-to-publish social post rather than raw material. */
export function isPostShapedDraft(text: string): boolean {
  return DRAFT_MARKERS.some(re => re.test(text));
}

export function renderPostIdeasOpening(fetched: ContainerFetch<NewsItemInput>): string {
  if (!fetched.ok) return CONTAINER_FETCH_FAILED_MESSAGE;
  const lines: string[] = [];
  for (const item of fetched.items ?? []) {
    const title = nonEmpty(item?.title);
    const url = httpUrl(item?.url);
    if (!title || !url) continue;
    const summary = nonEmpty(item?.summary);
    const entry = `- ${title}${summary ? ` (${summary})` : ''}\n  ${url}`;
    if (isPostShapedDraft(entry)) continue;
    lines.push(entry);
  }
  if (lines.length === 0) return CONTAINER_FETCH_FAILED_MESSAGE;
  return `Fresh news to react to (angles only, the take is yours):\n${lines.join('\n')}`;
}
