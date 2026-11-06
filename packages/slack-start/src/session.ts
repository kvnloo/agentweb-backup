/**
 * Per-tab intake session. The intake token is a bearer capability, so it lives in
 * sessionStorage only — never in the URL, never in localStorage.
 */
export interface StoredSession {
  intakeId?: string;
  intakeToken?: string;
  idempotencyKey: string;
  email?: string;
  website?: string;
}

const key = (apiBase: string) => `aw-slack-start:${apiBase}`;

export function loadSession(apiBase: string): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(key(apiBase));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.idempotencyKey === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(apiBase: string, session: StoredSession): void {
  try {
    window.sessionStorage.setItem(key(apiBase), JSON.stringify(session));
  } catch {
    /* storage disabled: the wizard still works for this page view */
  }
}

export function clearSession(apiBase: string): void {
  try {
    window.sessionStorage.removeItem(key(apiBase));
  } catch {
    /* ignore */
  }
}

export function newIdempotencyKey(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function utmFromLocation(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search);
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = params.get(`utm_${k}`);
    if (v) utm[k] = v.slice(0, 200);
  }
  return Object.keys(utm).length ? utm : undefined;
}
