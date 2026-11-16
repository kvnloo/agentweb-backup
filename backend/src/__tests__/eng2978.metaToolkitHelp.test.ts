jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaActivityLog: jest.fn().mockResolvedValue({ data: [] }) } }));
import { META_ERROR_EXPLANATIONS } from '../mcp/metaToolkitDiagnostics';
import { getMetaHelpArticles, META_HELP_ARTICLES } from '../mcp/metaToolkitHelp';
import { annotateToolkitTools } from '../mcp/toolkitToolAnnotations';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { agentModeService } from '../services/agentModeService';

const credentials = { accountId: '123', accessToken: 'secret' };
const deps = (scopes: string[], extra: any = {}) => ({
  validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
  listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }]),
  now: () => 0,
  rateLimiter: { check: () => ({ allowed: true }) },
  ...extra,
}) as any;

describe('ENG-2978 curated help', () => {
  it('uses only HTTPS official Meta hosts without credentials', () => {
    for (const article of META_HELP_ARTICLES) {
      const url = new URL(article.url);
      expect(url.protocol).toBe('https:');
      expect(['facebook.com', 'www.facebook.com', 'developers.facebook.com']).toContain(url.hostname);
      expect(url.username + url.password + url.port).toBe('');
      expect(article.summary).not.toMatch(/\n/);
    }
  });
  it('reuses every diagnostics error key', () => {
    for (const code of Object.keys(META_ERROR_EXPLANATIONS)) {
      expect(getMetaHelpArticles({ code }).found).toBe(true);
      expect(getMetaHelpArticles({ subcode: code }).found).toBe(true);
    }
  });
  it('matches normalized topics and rate limits', () => {
    expect(getMetaHelpArticles({ topic: '  RATE   LIMITING ' }).articles[0].url).toContain('/rate-limiting/');
    expect(getMetaHelpArticles({ code: '80004' }).articles).toHaveLength(2);
  });
  it.each([{ topic: 'unknown topic' }, { code: '999999' }, { subcode: '999999' }, { topic: 'constructor' }])('does not invent articles for %o', (args) => {
    expect(getMetaHelpArticles(args)).toEqual({ found: false, articles: [], message: 'No curated article for this topic or error code.' });
  });
  it.each([{}, { topic: '' }, { code: ' 190' }, { code: 190 }, { topic: 'errors', url: 'https://evil.test' }])('rejects invalid arguments %o', (args) => {
    expect(() => getMetaHelpArticles(args)).toThrow();
  });
  it('advertises a read-only static tool', () => {
    expect(annotateToolkitTools(getMetaToolkitManifest()).find((d) => d.name === 'ads_get_help_article')).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
  });
  it('runs with read scope without resolving an account or writing', async () => {
    const d = deps(['tools:read'], { listAccounts: jest.fn(), recordUsage: jest.fn(), recordWrite: jest.fn() });
    const result = await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_get_help_article', args: { code: '190' } }, d);
    expect(result).toMatchObject({ found: true });
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(d.recordUsage).toHaveBeenCalledTimes(1);
    expect(d.recordWrite).not.toHaveBeenCalled();
    expect(agentModeService.readToolkitMetaActivityLog).not.toHaveBeenCalled();
  });
  it('denies keys without read scope', async () => {
    const d = deps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_get_help_article', args: { topic: 'errors' } }, d)).rejects.toMatchObject({ status: 403 });
    expect(d.listAccounts).not.toHaveBeenCalled();
  });
});
