import { getSecret } from '../utils/secretsManager';

/**
 * Minimal Featurebase client.
 *
 * Posts are created in Linear (tagged "Featurebase") and auto-imported by Featurebase —
 * so we do NOT create posts here. This client only does the two things the dedup
 * stacking flow needs: find the canonical's imported post by title, and add a voter
 * (an additional reporter) to it so the class-action signal + resolution emails work.
 *
 * Contract verified live (2026-06-28): GET /v2/posts?q=, POST /v2/posts/{id}/voters,
 * auth `Authorization: Bearer <apiKey>`, header `Featurebase-Version: 2026-01-01.nova`.
 */

const FB_API_BASE = 'https://do.featurebase.app/v2';
const FB_VERSION = '2026-01-01.nova';

export interface FeaturebaseCredentials {
  apiKey: string;
  appId?: string;
}

const credentialsCache: Record<string, FeaturebaseCredentials> = {};

export async function getFeaturebaseCredentialsForEnv(env: 'development' | 'production'): Promise<FeaturebaseCredentials> {
  if (credentialsCache[env]) return credentialsCache[env];
  const secretName = env === 'production' ? 'prod/AgentWeb/Featurebase' : 'dev/AgentWeb/Featurebase';
  const secretString = await getSecret(secretName);
  if (!secretString || secretString.trim() === '') {
    throw new Error(`Featurebase credentials secret is empty for ${env}`);
  }
  const credentials = JSON.parse(secretString) as FeaturebaseCredentials;
  if (!credentials.apiKey) throw new Error(`Featurebase credentials missing apiKey for ${env}`);
  credentialsCache[env] = credentials;
  return credentials;
}

export async function getFeaturebaseCredentials(): Promise<FeaturebaseCredentials> {
  const environment = process.env.NODE_ENV || 'development';
  return getFeaturebaseCredentialsForEnv(environment === 'production' ? 'production' : 'development');
}

async function featurebaseFetch(path: string, options: RequestInit = {}): Promise<any> {
  const { apiKey } = await getFeaturebaseCredentials();
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${FB_API_BASE}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Featurebase-Version': FB_VERSION,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      throw new Error(`Featurebase API error ${res.status}: ${data?.message || JSON.stringify(data)}`);
    }
    return data;
  }
  throw new Error('Featurebase API: rate-limit retries exhausted');
}

export interface FeaturebasePost {
  id: string;
  title: string;
  url?: string;
}

/** Find a post by (near-exact) title — used to resolve a canonical's imported post. */
export async function findPostByTitle(title: string): Promise<FeaturebasePost | null> {
  const q = encodeURIComponent(title.slice(0, 200));
  const data = await featurebaseFetch(`/posts?q=${q}&limit=5`, { method: 'GET' });
  const candidates: any[] = data?.data || [];
  const norm = (s: string) => (s || '').trim().toLowerCase();
  const exact = candidates.find((p) => norm(p.title) === norm(title));
  const chosen = exact || candidates[0];
  if (!chosen) return null;
  return { id: chosen.id, title: chosen.title, url: chosen.postUrl || chosen.url };
}

/** Add a voter (additional reporter) to a post, attributed by email. Auto-creates the contact. */
export async function addVoter(postId: string, email: string, name?: string): Promise<void> {
  await featurebaseFetch(`/posts/${postId}/voters`, {
    method: 'POST',
    body: JSON.stringify({ email, name: name || email }),
  });
}
