import {
  getHeaderNavigation,
  getGroupedHeaderNavigation,
  portalRouteCatalog,
} from '../catalog';

const EXPECTED_REGISTERED_ROUTES = [
  '/',
  '/login',
  '/register',
  '/oauth-callback',
  '/release',
  '/api',
  '/execution/:executionId/token/:token',
  '/tasks',
  '/templates',
  '/html-templates',
  '/skills',
  '/work-plans',
  '/schedule-templates',
  '/admin',
  '/gtm-ops',
  '/client-health',
  '/agent-runs',
  '/eval-labelling',
  '/eval-labelling/calibration',
  '/sandbox-accounts',
  '/prompt-templates',
  '/tasks/create',
  '/tasks/:taskId',
  '/tasks/:taskId/executions/:executionId',
  '/admin/tasks/:taskId',
  '/profile',
  '/profile/:userId',
  '/config',
  '/workflows',
  '/workflows/new',
  '/workflows/:id',
  '/workflows/:id/edit',
  '/workflows/:id/run',
  '/workflows/:id/executions/:executionId',
  '/contractor-accesses',
  '/marketing',
  '/marketing/social-listening',
  '/marketing/creative-generation',
  '/marketing/research',
  '/marketing/research/:taskId',
  '/marketing/market-research',
  '/marketing/report/:id',
  '/marketing/blog',
  '/marketing/*',
].sort();

describe('Partner Portal route catalog', () => {
  it('inventories every route registered by App and the nested marketing router', () => {
    const registeredRoutes = portalRouteCatalog
      .filter((entry) => entry.routeRegistered)
      .map((entry) => entry.routePattern)
      .sort();

    expect(registeredRoutes).toEqual(EXPECTED_REGISTERED_ROUTES);
  });

  it('preserves the existing admin header navigation order and destinations', () => {
    const navigation = getHeaderNavigation({
      authenticated: true,
      isAdmin: true,
      isContractor: false,
    });

    expect(navigation.map(({ label, destination }) => [label, destination])).toEqual([
      ['Home', '/'],
      ['Release', '/release'],
      ['Tasks', '/tasks'],
      ['Templates', '/templates'],
      ['HTML Templates', '/html-templates'],
      ['Skills', '/skills'],
      ['Work Plans', '/work-plans'],
      ['Schedule Templates', '/schedule-templates'],
      ['GTM Tracker', '/gtm-ops'],
      ['Client Health', '/client-health'],
      ['Agent Runs', '/agent-runs'],
      ['Eval Labelling', '/eval-labelling'],
      ['Sandbox Accounts', '/sandbox-accounts'],
      ['Prompt Templates', '/prompt-templates'],
      ['Workflows', '/workflows'],
      ['Config', '/config'],
      ['Admin', '/admin'],
    ]);
  });

  it('groups the approved admin header without hiding Admin', () => {
    const grouped = getGroupedHeaderNavigation({ authenticated: true, isAdmin: true, isContractor: true });
    expect(grouped.direct.map(({ label }) => label)).toEqual(['Home', 'Tasks', 'Workflows', 'Admin', 'Release']);
    expect(grouped.build.map(({ label }) => label)).toEqual([
      'Templates', 'HTML Templates', 'Prompt Templates', 'Skills', 'Work Plans', 'Schedule Templates',
    ]);
    expect(grouped.operate.map(({ label }) => label)).toEqual([
      'GTM Tracker', 'Client Health', 'Agent Runs', 'Eval Labelling', 'Sandbox Accounts', 'Contractor Accesses', 'Config',
    ]);
  });

  it('does not expose admin groups to a regular authenticated partner', () => {
    const grouped = getGroupedHeaderNavigation({ authenticated: true, isAdmin: false, isContractor: false });
    expect(grouped.direct.map(({ label }) => label)).toEqual(['Home', 'Tasks', 'Workflows', 'Release']);
    expect(grouped.build).toEqual([]);
    expect(grouped.operate.map(({ label }) => label)).toEqual(['Config']);
  });

  it('keeps contractor access in Operate only when the viewer has that role', () => {
    const withoutContractor = getGroupedHeaderNavigation({ authenticated: true, isAdmin: true, isContractor: false });
    const withContractor = getGroupedHeaderNavigation({ authenticated: true, isAdmin: true, isContractor: true });
    expect(withoutContractor.operate.map(({ label }) => label)).not.toContain('Contractor Accesses');
    expect(withContractor.operate.map(({ label }) => label)).toContain('Contractor Accesses');
  });

  it('redirects the four unbuilt marketing pages instead of flagging them as placeholders (ENG-3141)', () => {
    const redirected = ['/marketing/social-listening', '/marketing/creative-generation', '/marketing/report/:id', '/marketing/blog'];
    for (const pattern of redirected) {
      const entry = portalRouteCatalog.find(({ routePattern }) => routePattern === pattern);
      expect(entry).toMatchObject({ availability: 'redirect', navigationSurface: 'redirect', routeRegistered: true });
    }
  });

  it.each([
    ['admin', { authenticated: true, isAdmin: true, isContractor: false }],
    ['partner', { authenticated: true, isAdmin: false, isContractor: false }],
    ['contractor', { authenticated: true, isAdmin: false, isContractor: true }],
    ['customer', { authenticated: true, isAdmin: false, isContractor: false }],
    ['anonymous', { authenticated: false, isAdmin: false, isContractor: false }],
  ])('never offers a placeholder or dead-end destination to a %s viewer (ENG-3141)', (_viewer, context) => {
    const grouped = getGroupedHeaderNavigation(context);
    const items = [...getHeaderNavigation(context), ...grouped.direct, ...grouped.build, ...grouped.operate];
    expect(items.length).toBeGreaterThan(0);
    const unavailable = items.filter(({ availability }) => availability === 'placeholder' || availability === 'dead-end');
    expect(unavailable).toEqual([]);
  });

  it('keeps no in-page marketing link to a redirected placeholder (ENG-3141)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const home = fs.readFileSync(path.join(__dirname, '../../pages/marketing/Home.tsx'), 'utf8');
    for (const target of ['/marketing/social-listening', '/marketing/creative-generation', '/marketing/report/', '/marketing/blog']) {
      expect(home).not.toContain(`to="${target}`);
    }
  });

  it('no longer records the workflow builder post-save dead-end (ENG-2401)', () => {
    expect(portalRouteCatalog.some(({ routePattern }) => routePattern === '/workflows/builder/:id')).toBe(false);
  });

  it('contains no duplicate route inventory entries', () => {
    const routePatterns = portalRouteCatalog.map(({ routePattern }) => routePattern);
    expect(new Set(routePatterns).size).toBe(routePatterns.length);
  });
});
