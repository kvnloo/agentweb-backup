import type { SandboxDataset, SandboxOverlay } from './types';

export interface OverlayChange {
  collection: string;
  id: string;
  operation: 'created' | 'updated' | 'deleted';
  before?: unknown;
  after?: unknown;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const collections = ['campaigns', 'adsets', 'ads', 'adcreatives', 'adimages'] as const;
export function buildOverlayDiff(seed: SandboxDataset, overlay: SandboxOverlay): OverlayChange[] {
  const changes: OverlayChange[] = [];
  for (const collection of collections) {
    const originals = new Map<string, unknown>(seed[collection].map(row => ['id' in row ? row.id : row.hash, row]));
    const current = overlay[collection] as Record<string, unknown>;
    for (const id of [...new Set([...Object.keys(current), ...overlay.deletedIds.filter(id => originals.has(id))])].sort()) {
      const before = originals.get(id), after = current[id];
      if (overlay.deletedIds.includes(id)) {
        if (before !== undefined) changes.push({ collection, id, operation: 'deleted', before });
      } else if (before === undefined) changes.push({ collection, id, operation: 'created', after });
      else if (canonical(before) !== canonical(after)) changes.push({ collection, id, operation: 'updated', before, after });
    }
  }
  if (overlay.capiEvents.length) changes.push({ collection: 'capiEvents', id: 'events', operation: 'created', after: overlay.capiEvents });
  return changes;
}
export function orderSandboxAudit(audit: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...audit].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || String(a.evaluationKey ?? '').localeCompare(String(b.evaluationKey ?? '')));
}
export function renderSandboxReviewMarkdown(review: { userId: string; status: string; audit: Record<string, unknown>[]; overlayDiff?: OverlayChange[]; truncated?: boolean }): string {
  const safe = (value: unknown) => (JSON.stringify(value ?? null) ?? 'null').replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
  const lines = [`# Sandbox review: ${review.userId}`, '', `Status: ${review.status}`, '', '## Meta action timeline', ''];
  for (const event of orderSandboxAudit(review.audit).filter(row => row.action === 'meta')) {
    lines.push(`- ${safe(event.at)} — ${safe(event.method)} ${safe(event.path)} (HTTP ${safe(event.status ?? null)})`, `  - Arguments: ${safe(event.args ?? {})}`, `  - Result: ${safe(event.result ?? null)}`);
  }
  lines.push('', '## Overlay diff', '', '```json', JSON.stringify(review.overlayDiff ?? [], null, 2).replace(/`/g, '\\u0060'), '```');
  if (review.truncated) lines.push('', 'Audit is truncated.');
  return lines.join('\n') + '\n';
}
