/**
 * Presentation-only privacy boundary for Emma's direct TSP surfaces.
 * Never mutate AgentWeb session/approval records or outbound API payloads.
 * Like the operator's allowlisted projection, this is defense in depth:
 * credential-bearing data does not belong in a native surface.
 */
import type { TspNode } from './renderEmma';

const URL_KEY = /^(href|url|uri|src|imageurl|previewurl|customerportalurl)$/i;
const URL_TEXT = /https?:\/\/[^\s<>"'\])]+/gi;
const CREDENTIAL_IN_TEXT = /\b(?:authorization|proxy[-_]?authorization|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|cookie|set[-_]?cookie|x[-_]?amz[-_]?security[-_]?token|x[-_]?amz[-_]?signature|x[-_]?goog[-_]?signature|signature|jwt)\b["']?\s*[:=]\s*["']?(?:Bearer\s+)?[^\s"',}\]]+/gi;
const NAMED_CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9_-]{12,})\b/g;

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /(?:token|secret|credential|authorization|password|passwd|apikey|cookie|signature|privatekey|accesskey|bearer|jwt|signedurl)/.test(normalized)
    || normalized === 'auth';
}

/** Reject URL-embedded auth, signed links and all non-web schemes. */
export function safeEmmaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 2048 || /\s/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password || parsed.hash) return undefined;
    let credentialParameter = false;
    parsed.searchParams.forEach((_value, key) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (sensitiveKey(key) || /^(sig|auth|jwt|policy|awsaccesskeyid|googleaccessid|keypairid)$/.test(normalized)) {
        credentialParameter = true;
      }
    });
    if (credentialParameter) return undefined;
    // Preserve a validated benign query (e.g. ?page=2) for useful open/copy actions.
    return value;
  } catch {
    return undefined;
  }
}

/** Keep ordinary messages readable, withholding secrets and private links. */
export function safeEmmaText(value: unknown, limit = 8192): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ')
    .replace(URL_TEXT, url => safeEmmaUrl(url) ? url : '[private URL withheld]')
    .replace(CREDENTIAL_IN_TEXT, '[credential withheld]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(NAMED_CREDENTIAL, '[credential withheld]');
  const max = Math.max(0, Math.min(limit, 8192));
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Project arbitrary error/result objects into bounded, non-executable display
 * data. Skip sensitive keys recursively, including nested HTTP headers.
 */
function projectValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (sensitiveKey(key)) return undefined;
  if (typeof value === 'string') {
    return URL_KEY.test(key) ? safeEmmaUrl(value) : safeEmmaText(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth >= 8) return undefined;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let projected: unknown;
  if (value instanceof Error) {
    projected = {
      name: safeEmmaText(value.name, 80),
      message: safeEmmaText(value.message, 1600),
    };
  } else if (Array.isArray(value)) {
    projected = value.slice(0, 100)
      .map(item => projectValue(item, '', depth + 1, seen))
      .filter(item => item !== undefined);
  } else {
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(value).slice(0, 60)) {
      if (sensitiveKey(field)) continue;
      const safe = projectValue(child, field, depth + 1, seen);
      if (safe !== undefined) output[field] = safe;
    }
    projected = output;
  }
  seen.delete(value);
  return projected;
}

export function safeEmmaToolDetail(value: unknown, limit = 1200): string | undefined {
  if (value === undefined || value === null) return undefined;
  const projected = projectValue(value, '', 0, new WeakSet<object>());
  if (projected === undefined) return undefined;
  const text = typeof projected === 'string' ? projected : JSON.stringify(projected, null, 2);
  if (!text) return undefined;
  const max = Math.max(0, Math.min(limit, 4000));
  return text.length > max ? text.slice(0, max) + '\n…' : text;
}

/**
 * Last-mile guard for every Emma renderer, including session picker,
 * approval deck, work-plan HUD and AgentRun Inspector. This projection only
 * shapes output: interactive choices retain their original server IDs.
 */
export function safeEmmaNode(node: TspNode): TspNode {
  const props = node.p
    ? projectValue(node.p, '', 0, new WeakSet<object>()) as Record<string, unknown>
    : undefined;
  if (props && (node.k === 'editor' || node.k === 'input')) {
    // User-authored drafts are editable state, not imported AgentWeb data.
    if (node.p && Object.prototype.hasOwnProperty.call(node.p, 'text')) props.text = node.p.text;
  }
  if (props && node.k === 'picker' && node.p && Object.prototype.hasOwnProperty.call(node.p, 'query')) {
    props.query = node.p.query;
  }
  if (props && typeof node.p?.href === 'string' && !safeEmmaUrl(node.p.href)) {
    // An unsafe open link must never retain a clickable action.
    delete props.actions;
    delete props.href;
  }
  return {
    id: node.id,
    k: node.k,
    ...(props ? { p: props } : {}),
    ...(node.c ? { c: node.c.map(safeEmmaNode) } : {}),
  };
}
