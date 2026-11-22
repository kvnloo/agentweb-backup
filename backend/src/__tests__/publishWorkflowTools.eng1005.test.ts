/** ENG-1005: publish consent, complete workflows, and external MCP boundaries. */
const mockMcpFetch = jest.fn();
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: (...args: any[]) => mockMcpFetch(...args),
}));
const mockCreateBlog = jest.fn();
const mockPublishBlog = jest.fn();
jest.mock('../services/agentModeService', () => ({ agentModeService: {
  createBlogArticle: (...args: any[]) => mockCreateBlog(...args),
  publishBlogArticle: (...args: any[]) => mockPublishBlog(...args),
} }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';
import { getListedToolDefinitions } from '../mcp/server/toolDiscovery';
import { isPublishCall, isPublishCapableTool, isPublishCallWithinAuthorizedScope } from '../utils/schedulePublishAuthorization';
import { attachPublishRevalidation } from '../utils/scheduledPublishConsentGuard';
import * as consentGuard from '../utils/scheduledPublishConsentGuard';
import emmaApiRouter from '../routes/emmaApi';
import { authenticateToken } from '../middleware/auth';
import { EMMA_ROUTE_BUDGET, requireEmmaTokenBudget } from '../middleware/emmaTokenBudget';
import { callSatisfiesRequirement } from '../utils/requiredCallSatisfaction';
import { countsTowardRequirement, toolCallSucceeded } from '../utils/toolCallOutcome';

const NAMES = ['emma_publish_social_post', 'emma_publish_blog_post', 'emma_create_gtm_plan', 'emma_schedule_recurring_work'];
const CALLER = { userId: 'user-1', sessionId: 'sess-1', agentUserId: 'agent-1', isDelegatedAccess: true };
const SOCIAL = { account_id: 'account-1', content: '  Launch day!  ', media_urls: ['https://example.com/image.png'] };
const BLOG = { title_draft: 'Launch', content_draft: '# Launch\n\nOur news.', categories: ['News'] };
// Real createBlogArticle / WordPress publisher response shapes.
const ARTICLE = { success: true, data: { title: 'Launch', description: 'Our news', heroImageUrl: 'https://example.com/hero.png', htmlUrl: 'https://example.com/draft.html' } };

function tool(name: string) {
  const handler = mcpToolRegistry.getTool(name);
  if (!handler) throw new Error(`${name} is not registered`);
  return handler;
}
async function run(name: string, args: any, context: any = CALLER) {
  const result = await tool(name).execute(args, context);
  return JSON.parse(result.content[0].text);
}
const paths = () => mockMcpFetch.mock.calls.map(([request]) => request.path);

beforeEach(() => mockMcpFetch.mockReset());
afterEach(() => jest.restoreAllMocks());

describe('ENG-1005 surface and account boundary', () => {
  it.each(NAMES)('%s is listed, account-scoped, and has no action property', name => {
    expect(getListedToolDefinitions().map(d => d.name)).toContain(name);
    expect(tool(name).requiresUserAccount).toBe(true);
    expect(tool(name).definition.inputSchema.properties).not.toHaveProperty('action');
  });

  it.each(['post_on_account', 'create_blog_article', 'publish_blog_article'])('external execute refuses %s before its handler runs (ENG-974)', async name => {
    expect(tool(name).internalOnly).toBe(true);
    const handler = jest.spyOn(tool(name), 'execute');
    await expect(mcpToolRegistry.execute(name, {}, { externalMcp: true, isInternal: false }))
      .rejects.toThrow(/not available to external clients/i);
    expect(handler).not.toHaveBeenCalled();
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it.each(NAMES.slice(0, 2))('%s receives scheduled consent revalidation only for live publication', name => {
    expect(isPublishCapableTool(name)).toBe(true);
    expect(isPublishCall(name, { publish: true })).toBe(true);
    expect(attachPublishRevalidation(name, CALLER, { publish: true }).assertPublishStillAuthorized).toEqual(expect.any(Function));
    for (const publish of [undefined, false, 'true']) expect(isPublishCall(name, { publish })).toBe(false);
  });

  it('preserves workflow consent across the REST handoff to granular publishers', () => {
    expect(isPublishCallWithinAuthorizedScope('post_on_connected_account', {}, [NAMES[0]])).toBe(true);
    expect(isPublishCallWithinAuthorizedScope('publish_blog_article', {}, [NAMES[1]])).toBe(true);
    expect(isPublishCallWithinAuthorizedScope('publish_blog_article', {}, [NAMES[0]])).toBe(false);
  });

  it.each(NAMES.slice(0, 2))('%s earns publish completion credit only after explicit, successful publication', name => {
    for (const args of [{}, { publish: false }, { publish: 'true' }, { publish: true }]) {
      for (const published of [false, true]) {
        const expected = args.publish === true && published;
        const result = { published };
        for (const entry of [
          { name, arguments: args, result },
          { name, arguments: JSON.stringify(args), result: JSON.stringify(result) },
          { name, arguments: args, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } },
        ]) {
          expect(callSatisfiesRequirement(name, entry)).toBe(expected);
          expect(countsTowardRequirement(entry)).toBe(expected);
          expect(toolCallSucceeded(entry)).toBe(expected);
        }
      }
    }
    expect(callSatisfiesRequirement(name, { name, arguments: 'invalid JSON', result: {} })).toBe(false);
    expect(callSatisfiesRequirement(name, { name, arguments: { publish: true }, result: { content: [null] } })).toBe(false);
  });
});

describe('social: discover, compose/validate, then explicitly publish', () => {
  it.each([undefined, true])('returns connected accounts when no account was selected (publish=%s)', async publish => {
    const accounts = { accounts: [{ account_id: 'account-1', platform: 'linkedin' }] };
    mockMcpFetch.mockResolvedValueOnce(accounts);
    const result = await run(NAMES[0], { content: SOCIAL.content, publish });
    expect(result.accounts).toEqual(accounts.accounts);
    expect(result.published).toBe(false);
    expect(paths()).toEqual(['/api/oauth/connected-accounts']);
  });

  it.each([undefined, false, 'true'])('previews composed content without any publish call (publish=%s)', async publish => {
    const result = await run(NAMES[0], { ...SOCIAL, publish });
    expect(result).toMatchObject({ published: false, content: 'Launch day!' });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('validates/composes content before the post, rechecks consent, and returns the live URL', async () => {
    const consent = jest.fn().mockResolvedValue(null);
    mockMcpFetch.mockImplementationOnce(async request => {
      expect(consent).toHaveBeenCalledTimes(1);
      expect(request).toMatchObject({ method: 'POST', path: '/api/emma/post-on-account', context: CALLER,
        body: { ...SOCIAL, content: 'Launch day!' } });
      return { success: true, post_url: 'https://linkedin.com/feed/update/post-1' };
    });
    const result = await run(NAMES[0], { ...SOCIAL, publish: true }, { ...CALLER, assertPublishStillAuthorized: consent });
    expect(result).toMatchObject({ published: true, content: 'Launch day!', url: 'https://linkedin.com/feed/update/post-1' });
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
  });

  it.each([' ', 123, null])('rejects invalid content %s before posting', async content => {
    expect(await run(NAMES[0], { ...SOCIAL, content, publish: true })).toMatchObject({ status: 'failed' });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('does not post when consent was withdrawn mid-flight', async () => {
    const refusal = { success: false, blocked: true, reason: 'publish_consent', error: 'Consent withdrawn' };
    const result = await run(NAMES[0], { ...SOCIAL, publish: true }, { ...CALLER, assertPublishStillAuthorized: async () => refusal });
    expect(result).toMatchObject(refusal);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it.each([{ success: false, message: 'Denied' }, { success: true, post_url: {} }])('never claims a live URL on a failed/malformed response', async response => {
    mockMcpFetch.mockResolvedValueOnce(response);
    expect(await run(NAMES[0], { ...SOCIAL, publish: true })).toMatchObject({ published: response.success, url: null });
  });
});

describe('blog: draft locally, create then publish in one confirmed call', () => {
  it.each([undefined, false, 'true'])('returns composed draft with no outbound call (publish=%s)', async publish => {
    expect(await run(NAMES[1], { ...BLOG, publish })).toMatchObject({ published: false, title: BLOG.title_draft, content: BLOG.content_draft });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('creates the article then passes its assets to publication, returning the live URL', async () => {
    mockMcpFetch.mockResolvedValueOnce(ARTICLE).mockResolvedValueOnce({ success: true, data: { postUrl: 'https://blog.example.com/launch' } });
    expect(await run(NAMES[1], { ...BLOG, publish: true })).toMatchObject({ published: true, url: 'https://blog.example.com/launch' });
    expect(paths()).toEqual(['/api/emma/create-blog-article', '/api/emma/publish-blog-article']);
    expect(mockMcpFetch.mock.calls[0][0]).toMatchObject({ context: CALLER, body: { title_draft: BLOG.title_draft, content_draft: BLOG.content_draft } });
    expect(mockMcpFetch.mock.calls[1][0]).toMatchObject({ context: CALLER, body: {
      title: ARTICLE.data.title, description: ARTICLE.data.description, hero_image_url: ARTICLE.data.heroImageUrl,
      blog_html_url: ARTICLE.data.htmlUrl, status: 'published', categories: ['News'],
    } });
  });

  it.each([{ success: false, message: 'Generation failed' }, { ...ARTICLE, data: { ...ARTICLE.data, htmlUrl: {} } }])('does not publish a failed or malformed article', async article => {
    mockMcpFetch.mockResolvedValueOnce(article);
    expect(await run(NAMES[1], { ...BLOG, publish: true })).toMatchObject({ published: false });
    expect(paths()).toEqual(['/api/emma/create-blog-article']);
  });

  it('rechecks consent after composing the article and before the publish REST call', async () => {
    mockMcpFetch.mockResolvedValueOnce(ARTICLE);
    const refusal = { success: false, blocked: true, reason: 'publish_consent', error: 'Withdrawn' };
    const check = jest.fn().mockResolvedValue(refusal);
    expect(await run(NAMES[1], { ...BLOG, publish: true }, { ...CALLER, assertPublishStillAuthorized: check })).toMatchObject(refusal);
    expect(check).toHaveBeenCalledTimes(1);
    expect(paths()).toEqual(['/api/emma/create-blog-article']);
  });

  it('reports a successful publication with an unavailable URL honestly so it is not retried', async () => {
    mockMcpFetch.mockResolvedValueOnce(ARTICLE).mockResolvedValueOnce({ success: true, data: { cmsType: 'Webflow' } });
    expect(await run(NAMES[1], { ...BLOG, publish: true })).toMatchObject({ published: true, url: null, status: 'url_unavailable' });
  });
});

describe('blog REST adapters (invoke handlers directly; no server)', () => {
  function handler(path: string) {
    const layer = (emmaApiRouter as any).stack.find((layer: any) => layer.route?.path === path);
    expect(layer).toBeDefined();
    return layer.route.stack[0].handle;
  }
  function request(body: any) {
    return { body, user: { userId: 'owner-1' }, header: (name: string) => name === 'X-AgentWeb-Session' ? 'session-1' : undefined };
  }
  function response() {
    const res: any = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }
  beforeEach(() => { mockCreateBlog.mockReset(); mockPublishBlog.mockReset(); });

  it.each(['/create-blog-article', '/publish-blog-article'])('%s is behind auth and the metered quota middleware', path => {
    const stack = (emmaApiRouter as any).stack;
    const index = stack.findIndex((layer: any) => layer.route?.path === path);
    expect(index).toBeGreaterThan(1);
    expect(stack.slice(0, index).some((layer: any) => layer.handle === authenticateToken)).toBe(true);
    expect(stack.slice(0, index).some((layer: any) => layer.handle === requireEmmaTokenBudget)).toBe(true);
    expect(EMMA_ROUTE_BUDGET[`POST ${path}`]).toBe('metered');
  });

  it('creates with the authenticated owner and forwarded session, preserving the granular defaults', async () => {
    mockCreateBlog.mockResolvedValueOnce(ARTICLE);
    const res = response();
    await handler('/create-blog-article')(request({ ...BLOG, userId: 'attacker' }), res);
    expect(mockCreateBlog).toHaveBeenCalledWith(BLOG.title_draft, BLOG.content_draft, 'medium', '', '', 'owner-1', 'session-1', 'default', false);
    expect(res.json).toHaveBeenCalledWith(ARTICLE);
  });

  it('passes the rebuilt consent hook through to the CMS write', async () => {
    const check = jest.fn().mockResolvedValue(null);
    jest.spyOn(consentGuard, 'publishRevalidationForForwardedRun').mockReturnValue({ assertPublishStillAuthorized: check });
    mockPublishBlog.mockResolvedValueOnce({ success: true });
    await handler('/publish-blog-article')(request({ title: 'Launch', description: 'News', hero_image_url: 'https://example.com/hero.png', blog_html_url: 'https://example.com/article.html', status: 'published', categories: ['News'] }), response());
    expect(check).toHaveBeenCalledTimes(1);
    expect(mockPublishBlog).toHaveBeenCalledWith('Launch', 'News', 'https://example.com/hero.png', 'https://example.com/article.html', 'owner-1', 'session-1', 'published', undefined, ['News'], check);
  });

  it('refuses the REST publish before the service when consent was withdrawn', async () => {
    const refusal = { success: false, blocked: true, reason: 'publish_consent', error: 'Withdrawn' };
    jest.spyOn(consentGuard, 'publishRevalidationForForwardedRun').mockReturnValue({ assertPublishStillAuthorized: async () => refusal });
    const res = response();
    await handler('/publish-blog-article')(request({ title: 'Launch', description: 'News', hero_image_url: 'https://example.com/hero.png', blog_html_url: 'https://example.com/article.html', status: 'published' }), res);
    expect(mockPublishBlog).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(refusal);
  });
});

describe('GTM plan and work items in one call', () => {
  const phases = [{ title: 'Launch', work_items: [{ title: 'Write post' }, { title: 'Review post' }] }];
  it('creates plan, phase, and each work item with the returned IDs', async () => {
    mockMcpFetch.mockResolvedValueOnce({ success: true, data: { planId: 'plan-1', phases: [] } })
      .mockResolvedValueOnce({ success: true, data: { planId: 'plan-1', phases: [{ id: 'phase-1', title: 'Launch' }] } })
      .mockResolvedValue({ success: true, data: { planId: 'plan-1' } });
    expect(await run(NAMES[2], { title: 'Go to market', phases })).toMatchObject({ plan_id: 'plan-1' });
    expect(paths()).toEqual(['/api/gtm-plan', '/api/gtm-plan/plan-1/phases',
      '/api/gtm-plan/plan-1/phases/phase-1/work-items', '/api/gtm-plan/plan-1/phases/phase-1/work-items']);
    expect(mockMcpFetch.mock.calls.map(([r]) => r.body)).toEqual([
      { title: 'Go to market' }, { title: 'Launch' }, { title: 'Write post' }, { title: 'Review post' },
    ]);
    for (const [request] of mockMcpFetch.mock.calls) expect(request.context).toEqual(CALLER);
  });

  it('updates an existing plan and adds items to an existing phase', async () => {
    mockMcpFetch.mockResolvedValue({ success: true, data: { planId: 'plan/1' } });
    await run(NAMES[2], { plan_id: 'plan/1', description: 'Updated', phases: [{ phase_id: 'phase/1', work_items: [{ title: 'Ship' }] }] });
    expect(mockMcpFetch.mock.calls[0][0]).toMatchObject({ method: 'PUT', path: '/api/gtm-plan/plan%2F1', body: { description: 'Updated' } });
    expect(paths()[1]).toBe('/api/gtm-plan/plan%2F1/phases/phase%2F1/work-items');
  });

  it.each([null, { success: true, data: { planId: {} } }])('stops on a malformed plan response', async response => {
    mockMcpFetch.mockResolvedValueOnce(response);
    expect(await run(NAMES[2], { title: 'Launch', phases })).toMatchObject({ status: 'failed' });
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
  });

  it('does not attach work to a different phase when the response is malformed', async () => {
    mockMcpFetch.mockResolvedValueOnce({ success: true, data: { planId: 'plan-1', phases: [{ id: 'old' }] } })
      .mockResolvedValueOnce({ success: true, data: { phases: [null, 'bad', { id: 'old' }] } });
    expect(await run(NAMES[2], { title: 'Launch', phases })).toMatchObject({ status: 'failed', plan_id: 'plan-1' });
    expect(mockMcpFetch).toHaveBeenCalledTimes(2);
  });
});

describe('one-call recurring work', () => {
  it.each(['daily', 'weekly', 'monthly'])('creates a working %s schedule directly', async cadence => {
    mockMcpFetch.mockResolvedValueOnce({ scheduleId: 'schedule-1', nextRunTime: '2026-10-07T09:00:00Z' });
    expect(await run(NAMES[3], { schedule_name: 'Report', starting_message: 'Summarize traffic', cadence })).toMatchObject({ schedule_id: 'schedule-1' });
    expect(mockMcpFetch).toHaveBeenCalledWith({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: CALLER,
      body: { scheduleName: 'Report', startingMessage: 'Summarize traffic', scheduleFrequency: cadence } });
  });

  it('names missing variables explicitly before creating an unusable schedule', async () => {
    expect(await run(NAMES[3], { schedule_name: 'Report', starting_message: 'Summarize {{company}} for {{audience}}', cadence: 'weekly', variable_values: { company: 'Acme' } }))
      .toMatchObject({ missing_variables: ['audience'] });
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('supplies all variable values in the create call, with no second variable step', async () => {
    mockMcpFetch.mockResolvedValueOnce({ scheduleId: 'schedule-1' });
    await run(NAMES[3], { schedule_name: 'Report', starting_message: 'Summarize {{company}}', cadence: 'monthly', variable_values: { company: 'Acme' } });
    expect(mockMcpFetch).toHaveBeenCalledTimes(1);
    expect(mockMcpFetch.mock.calls[0][0].body.variableValues).toEqual({ company: 'Acme' });
  });
});
