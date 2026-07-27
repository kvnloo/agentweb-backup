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

emmaToolRegistry.register({
  name: 'save_browser_cookies',
  definition: {
    name: 'save_browser_cookies',
    description: 'Save all cookies from the current browser session so they can be reused in future sessions. Call this after successfully logging into a website. All cookies (including third-party) are saved together.',
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

    const runCodeTool = findPlaywrightRunCodeTool(context.service);
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    // Extract all cookies from browser context
    const result = await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: `async (page) => { const cookies = await page.context().cookies(); return JSON.stringify(cookies); }` },
      userId,
      context.sessionId
    );

    const cookiesJson = extractMcpResultText(result);
    const allCookies: any[] = JSON.parse(cookiesJson);

    if (allCookies.length === 0) {
      return { success: false, message: 'No cookies found in the browser session. Make sure you have navigated to a website first.' };
    }

    await browserCookieDb.saveCookies(userId, allCookies);

    return {
      success: true,
      message: `Saved ${allCookies.length} cookies. These will be available in future sessions.`,
      cookieCount: allCookies.length
    };
  }
});

emmaToolRegistry.register({
  name: 'load_browser_cookies',
  definition: {
    name: 'load_browser_cookies',
    description: 'Load all previously saved cookies into the current browser session. Call this at the start of a session before navigating to websites that require authentication.',
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

    const cookies = await browserCookieDb.getAllCookiesForUser(userId);

    if (!cookies || cookies.length === 0) {
      return { success: false, message: 'No saved cookies found. The user may need to log in manually.' };
    }

    const runCodeTool = findPlaywrightRunCodeTool(context.service);
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    // Inject all cookies into browser context
    const cookiesArg = JSON.stringify(cookies);
    await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: `async (page) => { const cookies = ${cookiesArg}; await page.context().addCookies(cookies); return "Loaded " + cookies.length + " cookies"; }` },
      userId,
      context.sessionId
    );

    return {
      success: true,
      message: `Loaded ${cookies.length} saved cookies into the browser session.`,
      cookieCount: cookies.length
    };
  }
});

emmaToolRegistry.register({
  name: 'mark_browser_session_failed',
  definition: {
    name: 'mark_browser_session_failed',
    description:
      'Report that a manually-imported browser session (Settings > Browser Sessions) for a domain did NOT actually authenticate, ' +
      'even though load_browser_cookies reported loading it. Call this when, after load_browser_cookies succeeded, ' +
      'the site still shows a signin/login page instead of the expected authenticated state — this means the ' +
      "user's manually-imported session cookie has died server-side (it can happen before its stored expiry estimate). " +
      "This does not fix the session — it flags it in the user's Settings so they know to re-import a fresh one. " +
      'Only call this for a domain the user manually imported, not for the automatic __all__ cookie jar.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain whose manually-imported session failed to authenticate (e.g. "rankai.ai").'
        }
      },
      required: ['domain']
    }
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId;
    if (!userId) throw new Error('Authentication required');

    const domain = (args?.domain || '').toLowerCase().trim();
    if (!domain) {
      return { success: false, error: 'domain is required' };
    }

    await browserCookieDb.markDomainCookiesFailed(userId, domain);

    return {
      success: true,
      message: `Flagged the manually-imported session for "${domain}" as failed. The user will see this in Settings > Browser Sessions and can re-import a fresh one.`
    };
  }
});

emmaToolRegistry.register({
  name: 'clear_browser_cookies',
  definition: {
    name: 'clear_browser_cookies',
    description: 'Clear all saved browser cookies for the current user. Use this if cookies are expired or causing login issues.',
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

    await browserCookieDb.deleteAllCookies(userId);
    return { success: true, message: 'Cleared all saved cookies.' };
  }
});
