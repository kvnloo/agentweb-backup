export type FeaturebasePostKind = 'bug' | 'feature';

export interface CreateFeaturebasePostParams {
  title: string;
  description: string;
  kind: FeaturebasePostKind;
  priority?: 'High' | 'Medium' | 'Low' | string;
  tags?: string[];
  attachmentUrls?: string[];
  reporter: {
    userId: string;
    email?: string;
    name?: string;
  };
  context?: Record<string, unknown>;
}

export interface CreateFeaturebasePostResult {
  postId: string;
  postUrl: string;
  linearIssueUrls: string[];
}

const DEFAULT_API_BASE_URL = 'https://do.featurebase.app';
const DEFAULT_API_VERSION = '2026-01-01.nova';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to create Featurebase posts`);
  }
  return value;
}

function boardIdForKind(kind: FeaturebasePostKind): string {
  if (kind === 'feature') {
    return requireEnv('FEATUREBASE_FEATURE_BOARD_ID');
  }
  return requireEnv('FEATUREBASE_BUG_BOARD_ID');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphize(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function contextHtml(context: Record<string, unknown> | undefined): string {
  const entries = Object.entries(context || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '';

  const rows = entries
    .map(([key, value]) => `<li><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value)).replace(/\n/g, '<br>')}</li>`)
    .join('');
  return `<h3>Report context</h3><ul>${rows}</ul>`;
}

function attachmentsHtml(attachmentUrls: string[] | undefined): string {
  const urls = (attachmentUrls || []).filter((url) => /^https?:\/\//.test(url));
  if (urls.length === 0) return '';

  const items = urls
    .map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`)
    .join('');
  return `<h3>Attachments</h3><ul>${items}</ul>`;
}

export function buildFeaturebasePostContent(params: Pick<CreateFeaturebasePostParams, 'description' | 'context' | 'attachmentUrls'>): string {
  return [
    paragraphize(params.description || ''),
    contextHtml(params.context),
    attachmentsHtml(params.attachmentUrls),
  ].filter(Boolean).join('');
}

function extractLinearIssueUrls(post: any): string[] {
  const linearLinks = Array.isArray(post?.integrations?.linear) ? post.integrations.linear : [];
  return linearLinks
    .map((link: any) => link?.issueUrl)
    .filter((url: unknown): url is string => typeof url === 'string' && url.length > 0);
}

export async function createFeaturebasePost(params: CreateFeaturebasePostParams): Promise<CreateFeaturebasePostResult> {
  const apiKey = requireEnv('FEATUREBASE_API_KEY');
  const boardId = boardIdForKind(params.kind);
  const apiBaseUrl = process.env.FEATUREBASE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const apiVersion = process.env.FEATUREBASE_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const statusId = params.kind === 'bug'
    ? process.env.FEATUREBASE_BUG_IN_REVIEW_STATUS_ID?.trim()
    : process.env.FEATUREBASE_FEATURE_IN_REVIEW_STATUS_ID?.trim();

  const body: Record<string, unknown> = {
    title: params.title,
    content: buildFeaturebasePostContent(params),
    boardId,
    tags: params.tags || [],
    commentsEnabled: true,
    notifyAdmins: false,
    visibility: 'authorOnly',
    upvotes: 0,
    author: {
      userId: params.reporter.userId,
      email: params.reporter.email,
      name: params.reporter.name || params.reporter.email || params.reporter.userId,
    },
    integrations: {
      linear: true,
    },
  };

  if (statusId) {
    body.statusId = statusId;
  }

  const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/v2/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Featurebase-Version': apiVersion,
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  let data: any = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || responseText || response.statusText;
    throw new Error(`Featurebase API error (${response.status}): ${message}`);
  }

  if (!data?.id || !data?.postUrl) {
    throw new Error('Featurebase API response missing id or postUrl');
  }

  return {
    postId: data.id,
    postUrl: data.postUrl,
    linearIssueUrls: extractLinearIssueUrls(data),
  };
}
