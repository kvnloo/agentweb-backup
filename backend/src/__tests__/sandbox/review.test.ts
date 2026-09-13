import { SandboxStateStore } from '../../services/sandbox/sandboxStateStore';
import { buildOverlayDiff, orderSandboxAudit, renderSandboxReviewMarkdown } from '../../services/sandbox/review';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';
import { buildFixtureDataset } from './fixtures/fixtureDataset';

test('review diff reports created, changed and deleted objects against seed', () => {
  const seed = buildFixtureDataset();
  const changed = { ...seed.campaigns[0], name: 'Changed' };
  const overlay = { ...EMPTY_OVERLAY, campaigns: { [changed.id]: changed }, deletedIds: [seed.ads[0].id] };
  expect(buildOverlayDiff(seed, overlay)).toEqual(expect.arrayContaining([
    expect.objectContaining({ collection: 'campaigns', id: changed.id, operation: 'updated', before: seed.campaigns[0], after: changed }),
    expect.objectContaining({ collection: 'ads', id: seed.ads[0].id, operation: 'deleted' }),
  ]));
});
test('timeline sorts timestamps then stable audit keys and renders actions plus diff', () => {
  const audit = [{ at: '2026-09-12T10:00:00Z', evaluationKey: 'b', action: 'meta', method: 'POST', path: '123/campaigns' }, { at: '2026-09-11T10:00:00Z', evaluationKey: 'a', action: 'meta', method: 'GET', path: 'me' }];
  expect(orderSandboxAudit(audit).map(a => a.evaluationKey)).toEqual(['a', 'b']);
  const markdown = renderSandboxReviewMarkdown({ userId: 'eval_test', status: 'revoked', audit, overlayDiff: [] });
  expect(markdown.indexOf('GET')).toBeLessThan(markdown.indexOf('POST'));
  expect(markdown).toContain('Overlay diff');
});
test('overlay store rejects malformed persisted state rather than serving unsafe objects', async () => {
  const db = { get: jest.fn(() => ({ promise: async () => ({ Item: { userId: 'eval_test', overlay: { ...EMPTY_OVERLAY, campaigns: { '123': 'bad' } } } }) })) };
  await expect(new SandboxStateStore(db as any).loadOverlay('eval_test')).rejects.toThrow();
});
test('audit removes credentials from nested arguments and paging links', async () => {
  const put = jest.fn(() => ({ promise: async () => ({}) }));
  await new SandboxStateStore({ put } as any).recordAction({ userId: 'eval_test', token: 'secret', method: 'GET', version: 'v25.0', path: 'me', query: { access_token: 'secret', nested: '{"client_secret":"private"}' } }, { status: 200, headers: {}, body: '{"paging":{"next":"https://graph.facebook.com?access_token=secret"}}' }, new Date('2026-09-12T00:00:00Z'));
  const saved = JSON.stringify(put.mock.calls[0]);
  expect(saved).not.toContain('secret');
  expect(saved).not.toContain('private');
});
test('missing overlay is a fresh empty overlay', async () => {
  const db = { get: () => ({ promise: async () => ({}) }) };
  expect(await new SandboxStateStore(db as any).loadOverlay('eval_test')).toEqual(EMPTY_OVERLAY);
});

test('legacy Meta audit records with missing fields render safely and still escape markup', () => {
  const markdown = renderSandboxReviewMarkdown({ userId: 'eval_test', status: 'revoked', audit: [
    { action: 'meta' }, { action: 'meta', path: '<script>`' },
  ] });
  expect(markdown).toContain('null — null null (HTTP null)');
  expect(markdown).toContain('\\u003cscript>\\u0060');
});
