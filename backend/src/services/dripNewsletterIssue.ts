/**
 * ENG-2552 (child of ENG-2167): pure monthly newsletter issue structure validator.
 *
 * Each issue covers one educational topic, one customer story and a soft
 * "book a call" CTA. Pure: no I/O, no Resend, no persistence. Fails closed.
 */

export type NewsletterSectionKind = 'topic' | 'customer_story';

export interface NewsletterSection {
  kind: NewsletterSectionKind | string;
  title?: string;
  body?: string;
}

export interface NewsletterCta {
  kind: string;
  label?: string;
  url: string;
}

export interface NewsletterIssue {
  subject: string;
  sections: NewsletterSection[];
  ctas: NewsletterCta[];
  body: string;
}

export type NewsletterIssueError =
  | 'invalid_input'
  | 'subject_missing'
  | 'subject_too_long'
  | 'topic_missing'
  | 'topic_duplicate'
  | 'customer_story_missing'
  | 'customer_story_duplicate'
  | 'unknown_section'
  | 'cta_missing'
  | 'cta_multiple'
  | 'cta_not_book_call'
  | 'cta_url_invalid'
  | 'unsubscribe_missing';

export type NewsletterIssueValidation =
  | { ok: true }
  | { ok: false; errors: NewsletterIssueError[] };

export const NEWSLETTER_SUBJECT_MAX = 120;

// ENG-2557: require a clickable link. Bare "/unsubscribe" text or a placeholder outside an
// href does not count; the href must be a merge placeholder or an http(s) URL whose path
// contains an /unsubscribe segment.
const UNSUBSCRIBE_RE =
  /<a\b[^>]*\shref\s*=\s*(["'])\s*(?:\{\{\s*unsubscribe_url\s*\}\}|\{\{\{\s*RESEND_UNSUBSCRIBE_URL\s*\}\}\}|https?:\/\/[^\s"'<>/]+(?:\/[^\s"'<>]*)?\/unsubscribe(?:[/?#][^\s"'<>]*)?)\s*\1/i;

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

export function validateNewsletterIssue(issue: unknown): NewsletterIssueValidation {
  if (!issue || typeof issue !== 'object') return { ok: false, errors: ['invalid_input'] };
  const i = issue as Partial<NewsletterIssue>;
  if (!Array.isArray(i.sections) || !Array.isArray(i.ctas) || typeof i.body !== 'string') {
    return { ok: false, errors: ['invalid_input'] };
  }

  const errors: NewsletterIssueError[] = [];
  const subject = typeof i.subject === 'string' ? i.subject.trim() : '';
  if (!subject) errors.push('subject_missing');
  else if (subject.length > NEWSLETTER_SUBJECT_MAX) errors.push('subject_too_long');

  let topics = 0;
  let stories = 0;
  for (const s of i.sections) {
    const kind = s && typeof s === 'object' ? s.kind : undefined;
    if (kind === 'topic') topics++;
    else if (kind === 'customer_story') stories++;
    else if (!errors.includes('unknown_section')) errors.push('unknown_section');
  }
  if (topics === 0) errors.push('topic_missing');
  if (topics > 1) errors.push('topic_duplicate');
  if (stories === 0) errors.push('customer_story_missing');
  if (stories > 1) errors.push('customer_story_duplicate');

  if (i.ctas.length === 0) errors.push('cta_missing');
  else {
    if (i.ctas.length > 1) errors.push('cta_multiple');
    if (i.ctas.some((c) => !c || c.kind !== 'book_call')) errors.push('cta_not_book_call');
    if (i.ctas.some((c) => !c || !isHttpsUrl(c.url))) errors.push('cta_url_invalid');
  }

  if (!UNSUBSCRIBE_RE.test(i.body)) errors.push('unsubscribe_missing');

  return errors.length ? { ok: false, errors } : { ok: true };
}
