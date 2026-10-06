import { enforceEvaluationTool, EvaluationDenied, classifySandboxTool, SANDBOX_TOOL_CLASS_NAMES } from '../services/evaluationPolicy';
import { ToolRegistry } from '../mcp/client/toolRegistry';
import { McpToolRegistry } from '../mcp/server/registry';
import { getUserFromToken } from '../middleware/auth';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { evaluationStore } from '../services/evaluationStore';

jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_name: string, context: unknown) => context,
}));
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-test-signing-secret-only' }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmailConsistent: jest.fn() } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn() } }));

const activeRecord = (extra: Record<string, unknown> = {}) =>
  ({ userId: 'eval_test', email: 'case@example.invalid', status: 'active', expiresAt: Date.now() + 60000, ...extra });

// ENG-1907 AC 2: denied classes fail closed in every dispatcher; everything else runs (ENG-1906 decision 6).
const DENIED: Array<[string, string]> = [
  ['evaluation_workspace', 'lifecycle'],
  ['connect_account', 'connectors'], ['install_mcp_server', 'connectors'], ['configure_mcp_server', 'connectors'],
  ['send_email', 'sends'], ['notify_session', 'sends'], ['slack_send_message', 'sends'], ['enqueue_human_eval', 'sends'], ['email', 'sends'],
  ['linkedin_outreach', 'social'], ['twitter_manage_post', 'social'], ['post_on_connected_account', 'social'], ['google_calendar_create_event', 'social'],
  ['publish_landing_page_changes', 'publish'], ['deploy_landing_page', 'publish'], ['configure_landing_page_subdomain', 'publish'], ['enable_lead_list_public_access', 'publish'], ['enable_session_tracking', 'publish'],
  ['call_google_ads_api', 'third_party_writes'], ['call_hubspot_api', 'third_party_writes'], ['enrich_leads_execute', 'third_party_writes'], ['google_drive_search', 'third_party_writes'],
  ['playwright_browser_navigate', 'browser'], ['browser_run_code', 'browser'], ['save_browser_cookies', 'browser'], ['open_site_signin', 'browser'], ['solve_captcha', 'browser'],
  ['coding_agent', 'automation'], ['manage_scheduled_chat', 'automation'], ['create_schedule_from_template', 'automation'],
];
const ALLOWED = [
  'create_meta_campaign', 'call_meta_marketing_api', 'list_meta_ads_campaigns', 'get_meta_ads_metrics', 'call_meta_ads_insights_api',
  'generate_image', 'generate_video', 'you_search_web', 'search_knowledge_base', 'create_work_plan', 'search_leads',
  'generate_landing_page', 'iterate_landing_page', 'update_brand_guidelines', 'save_memory', 'install_skills', 'list_connected_accounts',
  'unknown_future_tool',
];

describe('classifySandboxTool', () => {
  it.each(DENIED)('%s is class %s', (name, cls) => expect(classifySandboxTool(name)).toBe(cls));
  it.each(ALLOWED)('%s is unclassified (allowed)', name => expect(classifySandboxTool(name)).toBeNull());
  it('exposes every class name used for defaults', () => {
    expect(SANDBOX_TOOL_CLASS_NAMES).toEqual(expect.arrayContaining(['lifecycle', 'connectors', 'sends', 'social', 'publish', 'third_party_writes', 'browser', 'automation']));
  });
});

describe('ENG-1907 acceptance: denied tool classes cannot execute for a sandbox principal', () => {
  const execute = jest.fn().mockResolvedValue({ success: true });
  const context = { userId: 'eval_test', sessionId: 's', llmModel: 'test', service: {}, isDelegatedAdmin: true, mockMode: true };
  beforeEach(() => { execute.mockClear(); (evaluationStore.get as jest.Mock).mockResolvedValue(activeRecord()); });

  it.each(DENIED.map(([name]) => name))('Emma (live ToolRegistry) denies %s even with inherited admin and mock-mode flags', async name => {
    const registry = new ToolRegistry();
    registry.register({ name, definition: {}, execute });
    await expect(registry.execute(name, {}, context)).rejects.toBeInstanceOf(EvaluationDenied);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(DENIED.map(([name]) => name))('external MCP registry denies %s', async name => {
    const registry = new McpToolRegistry();
    registry.register({ name, definition: {}, execute });
    await expect(registry.execute(name, {}, { ...context, externalMcp: true })).rejects.toBeInstanceOf(EvaluationDenied);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(ALLOWED)('Emma allows %s for a sandbox principal', async name => {
    const registry = new ToolRegistry();
    registry.register({ name, definition: {}, execute });
    await expect(registry.execute(name, {}, context)).resolves.toEqual({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('the denial names the tool and its class', async () => {
    await expect(enforceEvaluationTool('eval_test', 'send_email')).rejects.toThrow('Tool "send_email" is not available in this sandbox workspace (sends).');
  });
  it('a legacy policy row without deniedToolClasses denies every class', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue(activeRecord({ remaining: 5, materials: [], simulation: { seed: [], objects: [] } }));
    await expect(enforceEvaluationTool('eval_test', 'call_google_ads_api')).rejects.toBeInstanceOf(EvaluationDenied);
    await expect(enforceEvaluationTool('eval_test', 'get_meta_ads_metrics')).resolves.toBeUndefined();
  });
  it('an explicit deniedToolClasses subset is honored, but lifecycle is always denied', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue(activeRecord({ deniedToolClasses: ['sends'] }));
    await expect(enforceEvaluationTool('eval_test', 'send_email')).rejects.toBeInstanceOf(EvaluationDenied);
    await expect(enforceEvaluationTool('eval_test', 'call_google_ads_api')).resolves.toBeUndefined();
    await expect(enforceEvaluationTool('eval_test', 'evaluation_workspace')).rejects.toBeInstanceOf(EvaluationDenied);
  });
  it('a revoked or expired policy denies allowed tools too', async () => {
    (evaluationStore.get as jest.Mock).mockResolvedValue(activeRecord({ status: 'revoked' }));
    await expect(enforceEvaluationTool('eval_test', 'get_meta_ads_metrics')).rejects.toBeInstanceOf(EvaluationDenied);
    (evaluationStore.get as jest.Mock).mockResolvedValue(activeRecord({ expiresAt: Date.now() - 1 }));
    await expect(enforceEvaluationTool('eval_test', 'get_meta_ads_metrics')).rejects.toBeInstanceOf(EvaluationDenied);
  });

  it('an evaluation service token cannot inherit staff authorization', async () => {
    const token = jwt.sign({ userId: 'eval_test', email: 'test@example.invalid', isAdmin: true, _svc: true }, 'synthetic-test-signing-secret-only');
    const result = await getUserFromToken({ headers: { authorization: `Bearer ${token}` } } as any);
    expect(result.user).toBeNull();
  });

  it.each(['admin', undefined, null])('evaluation lifecycle cannot replace its execution identity with %p', async override => {
    await expect((enforceEvaluationTool as any)('eval_test', 'evaluation_workspace', { userId: override })).rejects.toBeInstanceOf(EvaluationDenied);
  });
  it('a sandbox principal cannot execute an allowed tool as someone else', async () => {
    await expect(enforceEvaluationTool('eval_test', 'get_meta_ads_metrics', { userId: 'customer' })).rejects.toBeInstanceOf(EvaluationDenied);
  });
  it('ordinary customer tool execution is unchanged, including denied-class tools', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'send_email', definition: {}, execute });
    await expect(registry.execute('send_email', {}, { ...context, userId: 'customer' })).resolves.toEqual({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(evaluationStore.get).not.toHaveBeenCalled();
  });
  it('a just-provisioned evaluation authenticates through its primary record before its GSI catches up', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined);
    (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', isActive: true, isAdmin: false });
    const token = jwt.sign({ userId: 'eval_test', email: 'case@example.invalid' }, 'synthetic-test-signing-secret-only');
    const result = await getUserFromToken({ headers: { authorization: `Bearer ${token}` } } as any);
    expect(result.user).toMatchObject({ userId: 'eval_test', isAdmin: false, roles: ['customer'] });
  });
});
