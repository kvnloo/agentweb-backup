export type PortalAccess =
  | 'public'
  | 'shared-token'
  | 'authenticated'
  | 'partner'
  | 'admin'
  | 'contractor'
  | 'customer';

export type PortalAvailability =
  | 'available'
  | 'redirect'
  | 'placeholder'
  | 'dead-end';

export type NavigationSurface =
  | 'primary'
  | 'account'
  | 'contextual'
  | 'redirect';

export type HeaderAudience =
  | 'everyone'
  | 'anonymous'
  | 'authenticated'
  | 'admin'
  | 'contractor';

export interface PortalRouteCatalogEntry {
  id: string;
  label: string;
  destination: string;
  routePattern: string;
  userJob: string;
  access: PortalAccess;
  availability: PortalAvailability;
  navigationSurface: NavigationSurface;
  primaryAction: string;
  emptyState: string;
  routeRegistered: boolean;
  header?: {
    audience: HeaderAudience;
    order: number;
  };
}

export interface HeaderNavigationContext {
  authenticated: boolean;
  isAdmin: boolean;
  isContractor: boolean;
}

interface CatalogOptions {
  availability?: PortalAvailability;
  surface?: NavigationSurface;
  routePattern?: string;
  routeRegistered?: boolean;
  header?: PortalRouteCatalogEntry['header'];
}

function route(
  id: string,
  label: string,
  destination: string,
  userJob: string,
  access: PortalAccess,
  primaryAction: string,
  emptyState: string,
  options: CatalogOptions = {},
): PortalRouteCatalogEntry {
  return {
    id,
    label,
    destination,
    routePattern: options.routePattern ?? destination,
    userJob,
    access,
    availability: options.availability ?? 'available',
    navigationSurface: options.surface ?? 'contextual',
    primaryAction,
    emptyState,
    routeRegistered: options.routeRegistered ?? true,
    ...(options.header ? { header: options.header } : {}),
  };
}

export const portalRouteCatalog: readonly PortalRouteCatalogEntry[] = [
  route('home', 'Home', '/', 'Start partner work', 'public', 'Continue to Tasks', 'Redirects to /tasks; no local empty state', {
    availability: 'redirect',
    surface: 'primary',
    header: { audience: 'everyone', order: 0 },
  }),
  route('login', 'Login', '/login', 'Sign in', 'public', 'Authenticate', 'Shows authentication errors in place', {
    surface: 'account',
    header: { audience: 'anonymous', order: 100 },
  }),
  route('register', 'Register', '/register', 'Create a partner account', 'public', 'Register', 'Shows registration errors in place'),
  route('oauth-callback', 'OAuth callback', '/oauth-callback', 'Complete OAuth sign-in', 'public', 'Return to Tasks', 'Redirects to Login when callback data is invalid'),
  route('release', 'Release', '/release', 'Review release information', 'public', 'Read release details', 'Static content; no empty state', {
    surface: 'primary',
    header: { audience: 'everyone', order: 10 },
  }),
  route('api', 'API', '/api', 'Review API access', 'public', 'View API details', 'Page owns its loading and error states'),
  route(
    'shared-execution',
    'Shared execution',
    '/execution/:executionId/token/:token',
    'Review a shared execution',
    'shared-token',
    'Inspect execution',
    'Invalid or expired token is handled by the page',
  ),
  route('tasks', 'Tasks', '/tasks', 'Manage partner tasks', 'partner', 'Create or open a task', 'Empty task list offers Create Task', {
    surface: 'primary',
    header: { audience: 'authenticated', order: 20 },
  }),
  route('templates', 'Templates', '/templates', 'Reuse task templates', 'partner', 'Choose a template', 'Empty template collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 30 },
  }),
  route('html-templates', 'HTML Templates', '/html-templates', 'Manage HTML templates', 'partner', 'Create or edit a template', 'Empty template collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 40 },
  }),
  route('skills', 'Skills', '/skills', 'Manage reusable skills', 'partner', 'Create or edit a skill', 'Empty skill collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 50 },
  }),
  route('work-plans', 'Work Plans', '/work-plans', 'Manage work plans', 'partner', 'Create or inspect a plan', 'Empty plan collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 60 },
  }),
  route('schedule-templates', 'Schedule Templates', '/schedule-templates', 'Manage schedule templates', 'partner', 'Create or edit a schedule', 'Empty schedule collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 70 },
  }),
  route('admin', 'Admin', '/admin', 'Operate the platform', 'admin', 'Open an admin tool', 'Dashboard owns per-tool empty states', {
    surface: 'primary',
    header: { audience: 'admin', order: 150 },
  }),
  route('gtm-ops', 'GTM Tracker', '/gtm-ops', 'Track GTM plans', 'admin', 'Inspect GTM operations', 'Empty GTM state is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 80 },
  }),
  route('client-health', 'Client Health', '/client-health', 'Review client health', 'admin', 'Inspect a client', 'Empty client collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 90 },
  }),
  route('agent-runs', 'Agent Runs', '/agent-runs', 'Inspect agent executions', 'admin', 'Open a run', 'Empty run collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 100 },
  }),
  route('prompt-templates', 'Prompt Templates', '/prompt-templates', 'Manage prompt templates', 'admin', 'Create or edit a prompt', 'Empty prompt collection is handled by the page', {
    surface: 'primary',
    header: { audience: 'admin', order: 110 },
  }),
  route('task-create', 'Create task', '/tasks/create', 'Create partner work', 'partner', 'Submit task', 'Form validation is shown in place'),
  route('task-detail', 'Task detail', '/tasks/:taskId', 'Inspect and operate a task', 'partner', 'Run or update task', 'Missing task is handled by the page'),
  route(
    'task-execution',
    'Task execution',
    '/tasks/:taskId/executions/:executionId',
    'Inspect task execution evidence',
    'partner',
    'Review execution',
    'Missing execution is handled by the page',
  ),
  route('admin-task-detail', 'Admin task detail', '/admin/tasks/:taskId', 'Inspect a task as admin', 'admin', 'Review task', 'Missing task is handled by the page'),
  route('profile', 'Profile', '/profile', 'Manage own profile', 'authenticated', 'Update profile', 'Profile load errors are handled by the page', {
    surface: 'account',
  }),
  route('user-profile', 'User profile', '/profile/:userId', 'Inspect a user profile', 'authenticated', 'Review profile', 'Missing user is handled by the page'),
  route('config', 'Config', '/config', 'Manage shared configuration', 'public', 'Create or share config', 'Empty config collection offers creation', {
    surface: 'primary',
    header: { audience: 'authenticated', order: 130 },
  }),
  route('workflows', 'Workflows', '/workflows', 'Manage workflows', 'partner', 'Create or run a workflow', 'Empty workflow collection offers creation', {
    surface: 'primary',
    header: { audience: 'authenticated', order: 120 },
  }),
  route('workflow-new', 'New workflow', '/workflows/new', 'Build a workflow', 'partner', 'Save workflow', 'Builder starts with an empty workflow'),
  route('workflow-detail', 'Workflow detail', '/workflows/:id', 'Inspect a workflow', 'partner', 'Run or edit workflow', 'Missing workflow is handled by the page'),
  route('workflow-edit', 'Edit workflow', '/workflows/:id/edit', 'Edit a workflow', 'partner', 'Save workflow', 'Missing workflow is handled by the page'),
  route('workflow-run', 'Run workflow', '/workflows/:id/run', 'Run and review a workflow', 'partner', 'Start workflow', 'No executions state is handled by the page'),
  route(
    'workflow-execution',
    'Workflow execution',
    '/workflows/:id/executions/:executionId',
    'Inspect workflow execution evidence',
    'partner',
    'Review execution',
    'Missing execution is handled by the page',
  ),
  route(
    'contractor-accesses',
    'Contractor Accesses',
    '/contractor-accesses',
    'Manage contractor access',
    'contractor',
    'Review access',
    'Empty access collection is handled by the page',
    {
      surface: 'primary',
      header: { audience: 'contractor', order: 140 },
    },
  ),
  route('marketing', 'Marketing home', '/marketing', 'Open customer marketing workspace', 'customer', 'Choose marketing work', 'Home owns its empty state'),
  route('marketing-social-listening', 'Social listening', '/marketing/social-listening', 'Monitor social conversations', 'customer', 'Return to marketing', 'Not implemented; renders Not Found', {
    availability: 'placeholder',
  }),
  route('marketing-creative-generation', 'Creative generation', '/marketing/creative-generation', 'Generate marketing creative', 'customer', 'Return to marketing', 'Not implemented; renders Not Found', {
    availability: 'placeholder',
  }),
  route('marketing-research', 'Market research', '/marketing/research', 'Run market research', 'customer', 'Create or open research', 'Empty research collection is handled by the page'),
  route('marketing-research-detail', 'Research detail', '/marketing/research/:taskId', 'Review market research', 'customer', 'Open research result', 'Missing research task is handled by the page'),
  route('marketing-research-legacy', 'Legacy market research', '/marketing/market-research', 'Reach market research from the legacy URL', 'customer', 'Redirect to research', 'Redirects to /marketing/research', {
    availability: 'redirect',
    surface: 'redirect',
  }),
  route('marketing-report', 'Marketing report', '/marketing/report/:id', 'Review a marketing report', 'customer', 'View report', 'Placeholder component only', {
    availability: 'placeholder',
  }),
  route('marketing-blog', 'Marketing blog', '/marketing/blog', 'Review blog work', 'customer', 'View blog', 'Placeholder component only', {
    availability: 'placeholder',
  }),
  route('marketing-not-found', 'Marketing not found', '/marketing/*', 'Recover from an unknown marketing URL', 'customer', 'Return to marketing', 'Renders Not Found', {
    availability: 'placeholder',
  }),
  route(
    'workflow-builder-save-dead-end',
    'Saved workflow builder',
    '/workflows/builder/:id',
    'Continue editing a newly saved workflow',
    'partner',
    'Continue editing',
    'Reachable after save, but no matching route is registered',
    {
      availability: 'dead-end',
      routeRegistered: false,
    },
  ),
];

function audienceIsVisible(
  audience: HeaderAudience,
  context: HeaderNavigationContext,
): boolean {
  switch (audience) {
    case 'everyone':
      return true;
    case 'anonymous':
      return !context.authenticated;
    case 'authenticated':
      return context.authenticated;
    case 'admin':
      return context.authenticated && context.isAdmin;
    case 'contractor':
      return context.authenticated && context.isContractor;
  }
}

export function getHeaderNavigation(
  context: HeaderNavigationContext,
): readonly PortalRouteCatalogEntry[] {
  return portalRouteCatalog
    .filter((entry) => (
      entry.navigationSurface === 'primary'
      && entry.header
      && audienceIsVisible(entry.header.audience, context)
    ))
    .sort((left, right) => (left.header?.order ?? 0) - (right.header?.order ?? 0));
}

export function getPortalRoute(id: string): PortalRouteCatalogEntry {
  const entry = portalRouteCatalog.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown Partner Portal route catalog id: ${id}`);
  }
  return entry;
}
