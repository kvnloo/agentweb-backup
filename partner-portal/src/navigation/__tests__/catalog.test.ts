import {
  getHeaderNavigation,
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
      ['Prompt Templates', '/prompt-templates'],
      ['Workflows', '/workflows'],
      ['Config', '/config'],
      ['Admin', '/admin'],
    ]);
  });

  it('flags every known placeholder and reachable dead-end explicitly', () => {
    const unavailable = portalRouteCatalog
      .filter(({ availability }) => availability === 'placeholder' || availability === 'dead-end')
      .map(({ routePattern, availability }) => [routePattern, availability]);

    expect(unavailable).toEqual(expect.arrayContaining([
      ['/marketing/social-listening', 'placeholder'],
      ['/marketing/creative-generation', 'placeholder'],
      ['/marketing/report/:id', 'placeholder'],
      ['/marketing/blog', 'placeholder'],
      ['/workflows/builder/:id', 'dead-end'],
    ]));
  });

  it('contains no duplicate route inventory entries', () => {
    const routePatterns = portalRouteCatalog.map(({ routePattern }) => routePattern);
    expect(new Set(routePatterns).size).toBe(routePatterns.length);
  });
});
