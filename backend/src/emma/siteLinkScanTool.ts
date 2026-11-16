import { emmaToolRegistry } from './registry';
import type { McpToolHandler } from '../mcp/server/registry';
import { crawlWebsiteLinks, type SiteLinkCrawlerDeps } from '../services/siteLinkCrawlerService';

/**
 * ENG-1098 — scan_website_links: a read-only, site-wide broken-link scan.
 *
 * Thin adapter over crawlWebsiteLinks (SSRF-pinned, robots-aware, bounded by
 * page/link caps and a deadline). Usable from any agent-mode run, including
 * scheduled chats, so a recurring "check my site for broken links" schedule is
 * just a scheduled chat that calls this tool. Whether the scheduled report is
 * emailed is decided from this tool's executed result
 * (services/linkScanNotificationPolicy.ts), so the result shape is load-bearing.
 */
export const SCAN_WEBSITE_LINKS_TOOL_NAME = 'scan_website_links';

export function createScanWebsiteLinksTool(
  crawl: typeof crawlWebsiteLinks = crawlWebsiteLinks,
  deps: SiteLinkCrawlerDeps = {}
): McpToolHandler {
  return {
    name: SCAN_WEBSITE_LINKS_TOOL_NAME,
    readOnly: true,
    definition: {
      name: SCAN_WEBSITE_LINKS_TOOL_NAME,
      description:
        'Crawl a website (same-site pages only, respecting robots.txt) and check every internal and outbound link for broken targets (404/410 or unresolvable host). ' +
        'Read-only: makes HTTP requests only, changes nothing. Use for one-off or scheduled broken-link checks. ' +
        'Returns pagesScanned, linksChecked, brokenLinkCount + brokenLinks (url, status/error, pages it was found on), unverifiableLinkCount + unverifiableLinks (could not be confirmed either way), robotsSkipped, truncated and deadlineExceeded. ' +
        'If truncated or deadlineExceeded is true the scan was incomplete — say so; never report an incomplete scan as "no broken links".',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Start URL of the site to scan, e.g. "https://example.com/". http(s) only, standard ports.' },
          max_pages: { type: 'number', description: 'Maximum same-site pages to crawl (default 100, max 500).' },
          max_links: { type: 'number', description: 'Maximum distinct links to check (default 500, max 2000).' },
        },
        required: ['url'],
      },
    },
    execute: async (args: { url?: string; max_pages?: number; max_links?: number }, context?: any) => {
      const userId = context?.userId || context?.agentUserId;
      if (!userId) throw new Error('Authentication required');
      const url = typeof args?.url === 'string' ? args.url.trim() : '';
      if (!url) throw new Error('url is required');
      return crawl(url, { maxPages: args.max_pages, maxLinks: args.max_links }, deps);
    },
  };
}

emmaToolRegistry.register(createScanWebsiteLinksTool());
