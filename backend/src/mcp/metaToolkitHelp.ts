import { META_ERROR_EXPLANATIONS } from './metaToolkitDiagnostics';
import { MetaToolkitRefusal } from './metaToolkitErrors';

/** Conservative static index: no network lookup and no generated URLs. */
export const META_HELP_ARTICLES = [
  {
    title: 'Marketing API error reference',
    url: 'https://developers.facebook.com/docs/marketing-api/error-reference/',
    summary: 'Official Marketing API error codes and troubleshooting reference.',
    topics: ['errors', 'error', 'marketing api', 'invalid parameter', 'permissions', 'access token'],
    codes: Object.keys(META_ERROR_EXPLANATIONS),
  },
  {
    title: 'Graph API rate limiting',
    url: 'https://developers.facebook.com/docs/graph-api/overview/rate-limiting/',
    summary: 'Official request limits, usage headers, and throttling guidance.',
    topics: ['rate limiting', 'rate limits', 'rate limit', 'throttling', 'backoff'],
    codes: ['4', '17', '613', '80004'],
  },
] as const;

export const HELP_ARTICLE_DEFINITION = {
  name: 'ads_get_help_article',
  description: 'Find curated official Meta documentation by topic or error code/subcode. Static read-only lookup; unknown queries return no curated article.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', minLength: 1, description: 'Documentation topic, such as rate limiting or permissions.' },
      code: { type: 'string', pattern: '^[0-9]+$', description: 'Meta error.code.' },
      subcode: { type: 'string', pattern: '^[0-9]+$', description: 'Meta error.error_subcode.' },
    },
    anyOf: [{ required: ['topic'] }, { required: ['code'] }, { required: ['subcode'] }],
    additionalProperties: false,
  },
};

/** Exact normalized topic aliases and error keys only: unknown inputs never invent a URL. */
export function getMetaHelpArticles(args: Record<string, unknown> = {}) {
  for (const key of Object.keys(args)) {
    if (!['topic', 'code', 'subcode'].includes(key)) throw new MetaToolkitRefusal(`Unsupported help-article argument: ${key}`);
  }
  if (!Object.keys(args).length) throw new MetaToolkitRefusal('Provide a topic, code, or subcode.');
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !value.trim() || (key !== 'topic' && !/^\d+$/.test(value))) {
      throw new MetaToolkitRefusal(`${key} must be ${key === 'topic' ? 'a non-empty string' : 'a numeric Meta error code'}.`);
    }
  }
  const topic = typeof args.topic === 'string' ? args.topic.trim().toLowerCase().replace(/\s+/g, ' ') : undefined;
  const articles = META_HELP_ARTICLES.filter((article) =>
    article.topics.some((alias) => alias === topic)
    || article.codes.some((code) => code === args.code || code === args.subcode),
  ).map(({ title, url, summary }) => ({ title, url, summary }));
  return { found: articles.length > 0, articles, ...(articles.length ? {} : { message: 'No curated article for this topic or error code.' }) };
}
