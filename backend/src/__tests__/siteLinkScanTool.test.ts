import { emmaToolRegistry } from '../emma/registry';
import { createScanWebsiteLinksTool, SCAN_WEBSITE_LINKS_TOOL_NAME } from '../emma/siteLinkScanTool';
import { isReadOnlyToolName } from '../utils/toolWriteClassification';
import type { SiteLinkCrawlerDeps } from '../services/siteLinkCrawlerService';

const ctx = { userId: 'user-1' };

describe('scan_website_links tool (ENG-1098)', () => {
  it('is registered on the Emma registry and classified read-only', () => {
    const tool = emmaToolRegistry.getTool(SCAN_WEBSITE_LINKS_TOOL_NAME);
    expect(tool?.readOnly).toBe(true);
    expect(tool?.definition.inputSchema.required).toEqual(['url']);
    expect(isReadOnlyToolName(SCAN_WEBSITE_LINKS_TOOL_NAME)).toBe(true);
  });

  it('runs the real crawler through injected transport and returns the scan result', async () => {
    const pages: Record<string, { status: number; data?: string }> = {
      'GET https://site.test/robots.txt': { status: 404 },
      'GET https://site.test/': { status: 200, data: '<a href="/gone">Gone</a><a href="/ok">Ok</a>' },
      'GET https://site.test/ok': { status: 200, data: '<p>ok</p>' },
      'GET https://site.test/gone': { status: 404 },
    };
    const deps: SiteLinkCrawlerDeps = {
      resolvePinned: async (url) => ({ hostname: new URL(url).hostname, address: '93.184.216.34', family: 4 }),
      request: async (url, _pinned, method) => {
        const reply = pages[`${method} ${url}`];
        if (!reply) throw new Error(`No fixture for ${method} ${url}`);
        return { status: reply.status, headers: { 'content-type': 'text/html' }, data: reply.data ?? '' };
      },
      sleep: async () => undefined,
    };
    const result = await createScanWebsiteLinksTool(undefined, deps).execute({ url: ' https://site.test/ ' }, ctx);
    expect(result).toMatchObject({ success: true, brokenLinkCount: 1, truncated: false, deadlineExceeded: false });
    expect(result.brokenLinks[0]).toMatchObject({ url: 'https://site.test/gone', status: 404 });
  });

  it('forwards caps to the crawler', async () => {
    const crawl = jest.fn().mockResolvedValue({ success: true });
    await createScanWebsiteLinksTool(crawl).execute({ url: 'https://site.test/', max_pages: 5, max_links: 50 }, ctx);
    expect(crawl).toHaveBeenCalledWith('https://site.test/', { maxPages: 5, maxLinks: 50 }, {});
  });

  it('rejects unauthenticated calls and missing url without crawling', async () => {
    const crawl = jest.fn();
    const tool = createScanWebsiteLinksTool(crawl);
    await expect(tool.execute({ url: 'https://site.test/' }, {})).rejects.toThrow(/Authentication/);
    await expect(tool.execute({ url: '  ' }, ctx)).rejects.toThrow(/url is required/);
    expect(crawl).not.toHaveBeenCalled();
  });

  it('surfaces crawler refusals (e.g. SSRF/private targets) as errors', async () => {
    const crawl = jest.fn().mockRejectedValue(new Error('Blocked: private or internal address'));
    await expect(createScanWebsiteLinksTool(crawl).execute({ url: 'http://127.0.0.1/' }, ctx)).rejects.toThrow(/private/);
  });
});
