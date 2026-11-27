import { buildCaptureRoute, buildLandingPageMiddleware } from '../v0Service';
import {
  runCaptureDriftSweep,
  __resetCaptureDriftAlertStateForTests,
  sitesFromPages,
  repoFullNameFromUrl,
  CAPTURE_DRIFT_ALERT_CLASS,
  captureDriftAlertScope,
  MIDDLEWARE_PATH,
  CAPTURE_ROUTE_PATH,
  CUSTOMIZED_CAPTURE_ROUTES,
} from '../captureDriftMonitor';

const CLEAN = {
  [MIDDLEWARE_PATH]: buildLandingPageMiddleware(),
  [CAPTURE_ROUTE_PATH]: buildCaptureRoute({ '/': 'list-1' }, 'https://x.example/api', '123', 'act_9'),
};

function repos(map: Record<string, Record<string, string | null> | 'throw'>) {
  return jest.fn(async (repo: string, path: string) => {
    const r = map[repo];
    if (r === 'throw') throw new Error('403 forbidden');
    return r?.[path] ?? null;
  });
}

describe('runCaptureDriftSweep (ENG-3120)', () => {
  beforeEach(() => __resetCaptureDriftAlertStateForTests());

  const sites = [
    { repoFullName: 'org/clean', name: 'Clean' },
    { repoFullName: 'org/drifted', name: 'Drifted' },
  ];
  const files = repos({
    'org/clean': CLEAN,
    'org/drifted': { ...CLEAN, [MIDDLEWARE_PATH]: CLEAN[MIDDLEWARE_PATH] + '\n// stale edit' },
  });

  it('alerts once for a drifted site naming the site and file, and stays silent for a clean one', async () => {
    const transport = jest.fn(async () => {});
    const s = await runCaptureDriftSweep({ listSites: async () => sites, readFile: files, transport, now: 1 });
    expect(s).toMatchObject({ sitesChecked: 2, clean: 1, drifted: 1, alertsSent: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [subject, body, ctx] = (transport.mock.calls[0] as any[]);
    expect(subject).toContain('Drifted');
    expect(body).toContain('org/drifted');
    expect(body).toContain('middleware.ts');
    expect(ctx).toMatchObject({ 'Alert Class': CAPTURE_DRIFT_ALERT_CLASS, 'Drifted Files': 'middleware.ts' });
  });

  it('two drifted sites file two distinct, repo-scoped oncall items (ENG-3143)', async () => {
    const transport = jest.fn(async () => {});
    const drift = { ...CLEAN, [MIDDLEWARE_PATH]: CLEAN[MIDDLEWARE_PATH] + '\n// stale edit' };
    const s = await runCaptureDriftSweep({
      listSites: async () => [
        { repoFullName: 'org/site-a', name: 'Site A' },
        { repoFullName: 'org/site-b', name: 'Site B' },
      ],
      readFile: repos({ 'org/site-a': drift, 'org/site-b': drift }),
      transport,
      now: 1,
    });
    expect(s).toMatchObject({ drifted: 2, alertsSent: 2 });
    const ctxs = transport.mock.calls.map((c: any[]) => c[2]);
    expect(ctxs.map((c: any) => c['Alert Class'])).toEqual([CAPTURE_DRIFT_ALERT_CLASS, CAPTURE_DRIFT_ALERT_CLASS]);
    expect(ctxs.map((c: any) => c['Alert Scope'])).toEqual(['lp-repo:org/site-a', 'lp-repo:org/site-b']);
    expect(new Set(ctxs.map((c: any) => c['Alert Scope'])).size).toBe(2);
    expect(captureDriftAlertScope('Org/Site-A')).toBe('lp-repo:org/site-a');
  });

  it('a repeat run inside the window does not re-file', async () => {
    const transport = jest.fn(async () => {});
    await runCaptureDriftSweep({ listSites: async () => sites, readFile: files, transport, now: 1000 });
    await runCaptureDriftSweep({ listSites: async () => sites, readFile: files, transport, now: 2000 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('an unreadable repo is logged and skipped without stopping the run', async () => {
    const transport = jest.fn(async () => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await runCaptureDriftSweep({
      listSites: async () => [{ repoFullName: 'org/broken', name: 'Broken' }, ...sites],
      readFile: repos({ 'org/broken': 'throw', 'org/clean': CLEAN, 'org/drifted': { [MIDDLEWARE_PATH]: null, [CAPTURE_ROUTE_PATH]: CLEAN[CAPTURE_ROUTE_PATH] } }),
      transport,
      now: 1,
    });
    expect(s).toMatchObject({ sitesChecked: 3, unreadable: 1, clean: 1, drifted: 1, alertsSent: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org/broken'));
    expect((transport.mock.calls[0] as any[])[1]).toContain('middleware.ts: missing');
    warn.mockRestore();
  });

  it('is read-only: only the injected reader touches repos, and dry run never consumes suppression', async () => {
    const transport = jest.fn(async () => {});
    await runCaptureDriftSweep({ listSites: async () => sites, readFile: files, transport, dryRun: true, now: 1 });
    await runCaptureDriftSweep({ listSites: async () => sites, readFile: files, transport, now: 2 });
    expect(transport).toHaveBeenCalledTimes(2);
    for (const call of files.mock.calls) expect([MIDDLEWARE_PATH, CAPTURE_ROUTE_PATH]).toContain(call[1]);
  });

  describe('acknowledged capture-route customizations (ENG-3179)', () => {
    const customized = 'org/customized';
    const customRoute = CLEAN[CAPTURE_ROUTE_PATH] + '\n// site-specific recruitment list';
    const ack = { [customized.toUpperCase()]: 'separate recruitment list (ENG-3179)' };

    it('a customized capture route on an acknowledged repo is not an alert', async () => {
      const transport = jest.fn(async () => {});
      const s = await runCaptureDriftSweep({
        listSites: async () => [{ repoFullName: customized, name: 'Custom' }],
        readFile: repos({ [customized]: { ...CLEAN, [CAPTURE_ROUTE_PATH]: customRoute } }),
        transport,
        customizedCaptureRoutes: ack,
        now: 1,
      });
      expect(s).toMatchObject({ sitesChecked: 1, clean: 1, drifted: 0, alertsSent: 0 });
      expect(transport).not.toHaveBeenCalled();
    });

    it('still alerts when that repo\'s middleware drifts', async () => {
      const transport = jest.fn(async () => {});
      const s = await runCaptureDriftSweep({
        listSites: async () => [{ repoFullName: customized, name: 'Custom' }],
        readFile: repos({
          [customized]: { [MIDDLEWARE_PATH]: CLEAN[MIDDLEWARE_PATH] + '\n// stale', [CAPTURE_ROUTE_PATH]: customRoute },
        }),
        transport,
        customizedCaptureRoutes: ack,
        now: 1,
      });
      expect(s).toMatchObject({ drifted: 1, alertsSent: 1 });
      expect((transport.mock.calls[0] as any[])[2]).toMatchObject({ 'Drifted Files': 'middleware.ts' });
    });

    it('still alerts when the acknowledged capture route is missing', async () => {
      const transport = jest.fn(async () => {});
      const s = await runCaptureDriftSweep({
        listSites: async () => [{ repoFullName: customized, name: 'Custom' }],
        readFile: repos({ [customized]: { [MIDDLEWARE_PATH]: CLEAN[MIDDLEWARE_PATH], [CAPTURE_ROUTE_PATH]: null } }),
        transport,
        customizedCaptureRoutes: ack,
        now: 1,
      });
      expect(s).toMatchObject({ drifted: 1, alertsSent: 1 });
    });

    it('the same customization on an unacknowledged repo still alerts', async () => {
      const transport = jest.fn(async () => {});
      const s = await runCaptureDriftSweep({
        listSites: async () => [{ repoFullName: 'org/other', name: 'Other' }],
        readFile: repos({ 'org/other': { ...CLEAN, [CAPTURE_ROUTE_PATH]: customRoute } }),
        transport,
        customizedCaptureRoutes: ack,
        now: 1,
      });
      expect(s).toMatchObject({ drifted: 1, alertsSent: 1 });
    });

    it('the production default acknowledges the ENG-3179 site', () => {
      expect(Object.keys(CUSTOMIZED_CAPTURE_ROUTES).map((k) => k.toLowerCase())).toContain(
        'agentwebpro/lp-create-a-high-converting-mobil-f80e1869',
      );
    });
  });
});

describe('site selection', () => {
  it('keeps only non-archived pages with a pixel and a repo, one entry per page', () => {
    const out = sitesFromPages(
      [
        { name: 'A', githubRepoUrl: 'https://github.com/org/a', metaPixelId: '1' },
        { name: 'B', githubRepoUrl: 'https://github.com/org/b' },
        { name: 'C', githubRepoUrl: 'https://github.com/org/c', metaPixelId: '1', archived: true },
        { name: 'D', metaPixelId: '1' },
      ],
      { userId: 'u1', email: 'e@x' },
    );
    expect(out).toEqual([{ repoFullName: 'org/a', name: 'A', userId: 'u1', email: 'e@x' }]);
    expect(repoFullNameFromUrl('https://github.com/org/r.git')).toBe('org/r');
  });
});
