import { runLanderUtmPreview } from '../scripts/preview-lander-utm';

describe('ENG-728 operator invocation', () => {
  it('reports explicitly requested missing records even if a stale link inventory exists', async () => {
    const result = await runLanderUtmPreview(['u', '/snapshot', 'missing'], {
      db: { query: jest.fn().mockReturnValue({ promise: async () => ({ Items: [] }) }) },
      getUser: async () => ({ userId: 'u' }),
      readSnapshot: async () => ({ userId: 'u', landers: { missing: [] } }),
    });
    expect(result.rows[0]).toMatchObject({ landerId: 'missing', status: 'error' });
  });

  it('rejects cross-user snapshots and any apply flag before reading storage', async () => {
    const query = jest.fn();
    const deps = { db: { query }, getUser: jest.fn(), readSnapshot: async () => ({ userId: 'foreign', landers: {} }) };
    await expect(runLanderUtmPreview(['u', '/snapshot'], deps)).rejects.toThrow(/requested userId/);
    await expect(runLanderUtmPreview(['u', '/snapshot', '--apply'], deps)).rejects.toThrow(/preview only/);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads all Dynamo pages and keeps missing artifacts as errors', async () => {
    const query = jest.fn()
      .mockReturnValueOnce({ promise: async () => ({ Items: [{ id: 'a', userId: 'u', name: 'a', status: 'deployed' }], LastEvaluatedKey: { id: 'a' } }) })
      .mockReturnValueOnce({ promise: async () => ({ Items: [{ id: 'b', userId: 'u', name: 'b', status: 'deployed', utmOverride: { utm_source: 'override' } }] }) });
    const result = await runLanderUtmPreview(['u', '/snapshot'], { db: { query }, getUser: async () => ({ userId: 'u' }), readSnapshot: async () => ({ userId: 'u', landers: {} }) });
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({ ExclusiveStartKey: { id: 'a' } }));
    expect(result.rows.map(row => row.status)).toEqual(['error', 'skipped']);
  });

  it('runs read-only production readers and returns per-lander diffs', async () => {
    const lander = { id: 'yugo-verify-lander', userId: 'yugo-verify-user', name: 'fixture', status: 'deployed' };
    const query = jest.fn().mockReturnValue({ promise: async () => ({ Items: [lander] }) });
    const getUser = jest.fn().mockResolvedValue({ userId: lander.userId, landerUtmDefault: { utm_source: 'new' } });
    const readSnapshot = jest.fn().mockResolvedValue({ userId: lander.userId, landers: { [lander.id]: [{ location: 'app/page.tsx:1', href: 'https://example.com/?utm_source=old&gclid=keep' }] } });
    const result = await runLanderUtmPreview([lander.userId, '/deployed-links.json'], { db: { query }, getUser, readSnapshot });
    expect(result.rows[0]).toMatchObject({ status: 'changed', changes: [{ params: { updated: { utm_source: { from: 'old', to: 'new' } }, removed: {} } }] });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ TableName: 'AW-LandingPages', IndexName: 'UserIdIndex' }));
    expect(readSnapshot).toHaveBeenCalledWith('/deployed-links.json');
  });
});
