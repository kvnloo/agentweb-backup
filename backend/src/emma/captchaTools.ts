import { emmaToolRegistry } from './registry';

/**
 * Finds the Playwright MCP tool name for browser_run_code.
 */
function findPlaywrightTool(service: any, suffix: string): string | null {
  const allTools = service.toolRegistry?.getAllTools?.() || [];
  for (const tool of allTools) {
    if (tool.name === suffix || tool.name.endsWith(`_${suffix}`)) {
      return tool.name;
    }
  }
  return null;
}

/**
 * Stealth initialization: injects JS patches to hide automation markers.
 * Should be called once at the start of a browser session, before navigating.
 */
emmaToolRegistry.register({
  name: 'stealth_browser_init',
  definition: {
    name: 'stealth_browser_init',
    description: 'Initialize browser stealth mode to reduce CAPTCHA triggers. Call this ONCE at the start of a browser session, before navigating to any website. It patches browser fingerprints to make the browser appear more like a regular user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  internal: true,
  execute: async (_args: any, context: any) => {
    const runCodeTool = findPlaywrightTool(context.service, 'browser_run_code');
    if (!runCodeTool) {
      throw new Error('Playwright browser tools are not available. Make sure a browser session is active.');
    }

    const stealthCode = `async (page) => {
      await page.context().addInitScript(() => {
        // Hide navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // Ensure window.chrome exists (missing in headless)
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            value: { runtime: {}, loadTimes: () => ({}), csi: () => ({}) },
            writable: false
          });
        }

        // Override navigator.plugins to look realistic
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
          ]
        });

        // Override navigator.languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });

        // Override permissions query to avoid automation detection
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission } as PermissionStatus);
          }
          return originalQuery.call(window.navigator.permissions, parameters);
        };
      });
      return "Stealth mode initialized";
    }`;

    await context.service.executeTool(
      context.llmModel,
      runCodeTool,
      { code: stealthCode },
      context.userId,
      context.sessionId
    );

    return { success: true, message: 'Browser stealth mode initialized. Anti-detection patches applied to reduce CAPTCHA triggers.' };
  }
});
