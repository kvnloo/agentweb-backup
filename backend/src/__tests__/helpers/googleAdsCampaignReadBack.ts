/**
 * ENG-592: GoogleAdsService.updateCampaign reads the campaign back after mutating it.
 * Suites that mock axios at the HTTP layer install this as the default POST
 * implementation so the read-back sees the campaign exactly as last written.
 * Queued mockResolvedValueOnce responses still take precedence.
 */
export function echoCampaignReadBack(mockPost: jest.Mock, fallback: unknown = { data: { results: [] } }): void {
  mockPost.mockImplementation(async (_url: string, body: any) => {
    if (typeof body?.query === 'string' && /FROM campaign WHERE campaign\.resource_name/.test(body.query)) {
      const writes = mockPost.mock.calls
        .map((c: any[]) => c[1]?.operations?.[0]?.update)
        .filter((u: any) => u && /\/campaigns\//.test(u.resourceName ?? ''));
      const u = writes[writes.length - 1] ?? {};
      const strategyKey = Object.keys(u).find((k) => /^(maximize|target|manual)/.test(k));
      const biddingStrategyType = strategyKey?.replace(/([A-Z])/g, '_$1').toUpperCase();
      return { data: { results: [{ campaign: { ...u, ...(biddingStrategyType ? { biddingStrategyType } : {}) } }] } };
    }
    // ENG-2398: generic echo for the other verified entities. Update read-backs see the
    // last write to that resource; remove read-backs see nothing (resource gone).
    const m = typeof body?.query === 'string'
      ? /FROM (\w+) WHERE \1\.resource_name = '([^']+)'/.exec(body.query)
      : null;
    if (m && m[1] !== 'campaign') {
      const [, entity, rn] = m;
      const rowKey = entity.replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase());
      const writes = mockPost.mock.calls
        .map((c: any[]) => c[1]?.operations?.[0]?.update)
        .filter((u: any) => u && u.resourceName === rn);
      const u = writes[writes.length - 1];
      return { data: { results: u ? [{ [rowKey]: u }] : [] } };
    }
    return fallback;
  });
}
