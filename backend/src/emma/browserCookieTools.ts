import { emmaToolRegistry } from './registry';
import { browserCookieDb } from '../services/db';

/**
 * Extracts the text content from an MCP tool result.
 * MCP tools return { content: string, raw: { content: [...] } } where content
 * may include markdown formatting like "### Result\n\"...\""
 */
function extractMcpResultText(result: any): string {
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else if (result?.raw?.content) {
    // Extract text from raw MCP content array
    const contentArray = Array.isArray(result.raw.content) ? result.raw.content : [];
    text = contentArray
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  } else if (result?.content) {
    text = result.content;
  } else {
    throw new Error('Failed to extract text from MCP tool result');
  }

  // Playwright MCP returns markdown like:
  // ### Result\n"[...]"\n### Ran Playwright code\n...
  // Extract just the value between "### Result" and the next "###" section
  const resultMatch = text.match(/^###\s+Result\s*\n([\s\S]*?)(?:\n###\s|$)/i);
  if (resultMatch) {
    text = resultMatch[1].trim();
  }

  // If the text is a JSON string wrapped in quotes (from Playwright's return value), unwrap it
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      // Not a valid JSON string, use as-is
    }
  }

  return text;
}

/**
 * Finds the Playwright MCP tool name for browser_run_code.
 * The tool may be prefixed with the server name (e.g., "playwright_browser_run_code").
 */
function findPlaywrightRunCodeTool(service: any): string | null {
  const allTools = service.toolRegistry?.getAllTools?.() || [];
  for (const tool of allTools) {
    if (tool.name === 'browser_run_code' || tool.name.endsWith('_browser_run_code')) {
      return tool.name;
    }
  }
  return null;
}

/**
 * Extracts the root domain from a full domain string.
 * e.g., "accounts.google.com" -> "google.com", "www.linkedin.com" -> "linkedin.com"
 */
function extractRootDomain(domain: string): string {
  const parts = domain.replace(/^\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

emmaToolRegistry.register({
  name: 'save_browser_cookies',
  definition: {
    name: 'save_browser_cookies',
    description: 'Save cookies from the current browser session for a domain so they can be reused in future sessions. Call this after successfully logging into a website. The cookies will persist across chat sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain to save cookies for (e.g., "google.com", "linkedin.com"). Cookies matching this domain and its subdomains will be saved.'
        }
      },
      required: ['domain']
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const domain = args.domain?.toLowerCase()?.trim();
    if (!domain) throw new Error('Domain is required');

    const runCodeTool = findPlaywrightRunCodeTool(context.service);
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    // Extract cookies from browser context
    const result = await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: `async (page) => { const cookies = await page.context().cookies(); return JSON.stringify(cookies); }` },
      userId,
      context.sessionId
    );

    // Parse the result - MCP tools return markdown-formatted content
    const cookiesJson = extractMcpResultText(result);
    const allCookies: any[] = JSON.parse(cookiesJson);

    // Filter cookies by domain (match root domain)
    const rootDomain = extractRootDomain(domain);
    const domainCookies = allCookies.filter((c: any) => {
      const cookieRoot = extractRootDomain(c.domain || '');
      return cookieRoot === rootDomain;
    });

    if (domainCookies.length === 0) {
      return { success: false, message: `No cookies found for domain "${domain}". Make sure you have navigated to the website first.` };
    }

    await browserCookieDb.saveCookies(userId, rootDomain, domainCookies);

    return {
      success: true,
      message: `Saved ${domainCookies.length} cookies for ${rootDomain}. These will be available in future sessions.`,
      domain: rootDomain,
      cookieCount: domainCookies.length
    };
  }
});

emmaToolRegistry.register({
  name: 'load_browser_cookies',
  definition: {
    name: 'load_browser_cookies',
    description: 'Load previously saved cookies for a domain into the current browser session. Call this before navigating to a website that requires authentication. Returns whether cookies were found and loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain to load cookies for (e.g., "google.com", "linkedin.com")'
        }
      },
      required: ['domain']
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const domain = args.domain?.toLowerCase()?.trim();
    if (!domain) throw new Error('Domain is required');

    const rootDomain = extractRootDomain(domain);
    const cookies = await browserCookieDb.getCookies(userId, rootDomain);

    if (!cookies || cookies.length === 0) {
      return { success: false, message: `No saved cookies for "${rootDomain}". The user may need to log in manually.`, domain: rootDomain };
    }

    const runCodeTool = findPlaywrightRunCodeTool(context.service);
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    // Inject cookies into browser context
    const cookiesArg = JSON.stringify(cookies);
    const result = await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: `async (page) => { const cookies = ${cookiesArg}; await page.context().addCookies(cookies); return "Loaded " + cookies.length + " cookies"; }` },
      userId,
      context.sessionId
    );

    return {
      success: true,
      message: `Loaded ${cookies.length} saved cookies for ${rootDomain}. You can now navigate to the website.`,
      domain: rootDomain,
      cookieCount: cookies.length
    };
  }
});

emmaToolRegistry.register({
  name: 'list_saved_domains',
  definition: {
    name: 'list_saved_domains',
    description: 'List all domains that have saved browser cookies for the current user. Use this to check if login cookies are available before navigating to a website.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const domains = await browserCookieDb.listDomains(userId);

    if (domains.length === 0) {
      return { success: true, domains: [], message: 'No saved login cookies. When you log into a website, cookies will be saved for future use.' };
    }

    return {
      success: true,
      domains,
      message: `Saved cookies for ${domains.length} domain(s): ${domains.join(', ')}`
    };
  }
});

emmaToolRegistry.register({
  name: 'clear_browser_cookies',
  definition: {
    name: 'clear_browser_cookies',
    description: 'Clear saved browser cookies. Use this if cookies are expired or causing login issues. Omit domain to clear all saved cookies.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain to clear cookies for (e.g., "google.com"). If omitted, clears all saved cookies.'
        }
      },
      required: []
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    if (args.domain) {
      const rootDomain = extractRootDomain(args.domain.toLowerCase().trim());
      await browserCookieDb.deleteCookies(userId, rootDomain);
      return { success: true, message: `Cleared saved cookies for ${rootDomain}.` };
    } else {
      await browserCookieDb.deleteAllCookies(userId);
      return { success: true, message: 'Cleared all saved cookies.' };
    }
  }
});
