import { emmaToolRegistry } from './registry';
import { testAccountsDb } from '../services/db';

function extractDomain(siteUrl: string): string {
  try {
    const url = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return siteUrl.toLowerCase().replace(/^www\./, '');
  }
}

emmaToolRegistry.register({
  name: 'get_test_account',
  definition: {
    name: 'get_test_account',
    description:
      'Look up a saved test account for a website by its URL or domain. ' +
      'Returns the login credentials (email + password) if one exists. ' +
      'If no account is found, returns null — in that case you should use get_temp_email ' +
      'to create a new account on the site via browser, then call save_test_account to store it.',
    inputSchema: {
      type: 'object',
      properties: {
        site_url: {
          type: 'string',
          description: 'The URL or domain of the website to look up (e.g. "https://app.example.com" or "example.com").',
        },
      },
      required: ['site_url'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required: no user context');
    if (!args.site_url) throw new Error('site_url is required');

    const domain = extractDomain(args.site_url);
    const accounts = await testAccountsDb.getByDomain(userId, domain);
    if (accounts.length === 0) {
      return {
        found: false,
        domain,
        message: `No saved test account for ${domain}. Use get_temp_email to create one, then call save_test_account.`,
      };
    }

    const account = accounts[0];
    return {
      found: true,
      accountId: account.accountId,
      domain: account.domain,
      siteUrl: account.siteUrl,
      email: account.email,
      password: account.password,
      notes: account.notes,
      source: account.source,
    };
  },
});

emmaToolRegistry.register({
  name: 'save_test_account',
  definition: {
    name: 'save_test_account',
    description:
      'Save login credentials for a website as a test account. ' +
      'Call this after successfully signing up or logging in to a site so the credentials are reused next time. ' +
      'If an account already exists for the domain it will be updated, otherwise a new one is created.',
    inputSchema: {
      type: 'object',
      properties: {
        site_url: {
          type: 'string',
          description: 'The full URL of the website (e.g. "https://app.example.com").',
        },
        email: {
          type: 'string',
          description: 'The email address used to log in.',
        },
        password: {
          type: 'string',
          description: 'The password for the account.',
        },
        notes: {
          type: 'string',
          description: 'Optional notes about this account (e.g. "created via temp email on signup page").',
        },
      },
      required: ['site_url', 'email', 'password'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required: no user context');
    if (!args.site_url) throw new Error('site_url is required');
    if (!args.email) throw new Error('email is required');
    if (!args.password) throw new Error('password is required');

    const domain = extractDomain(args.site_url);
    const existing = await testAccountsDb.getByDomain(userId, domain);
    if (existing.length > 0) {
      await testAccountsDb.update(existing[0].accountId, {
        email: args.email,
        password: args.password,
        siteUrl: args.site_url,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      });
      return {
        action: 'updated',
        accountId: existing[0].accountId,
        domain,
        email: args.email,
        message: `Updated existing test account for ${domain}.`,
      };
    }

    const account = await testAccountsDb.create(userId, {
      domain,
      siteUrl: args.site_url,
      email: args.email,
      password: args.password,
      notes: args.notes,
      source: 'auto-created',
    });

    return {
      action: 'created',
      accountId: account.accountId,
      domain,
      email: args.email,
      message: `Saved new test account for ${domain}.`,
    };
  },
});

emmaToolRegistry.register({
  name: 'list_test_accounts',
  definition: {
    name: 'list_test_accounts',
    description:
      'List all saved test accounts for the current user. ' +
      'Returns domains, emails, and notes — passwords are not included in the list. ' +
      'Use get_test_account to retrieve credentials for a specific site.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required: no user context');

    const accounts = await testAccountsDb.getByUserId(userId);
    return {
      count: accounts.length,
      accounts: accounts.map((a) => ({
        accountId: a.accountId,
        domain: a.domain,
        siteUrl: a.siteUrl,
        email: a.email,
        notes: a.notes,
        source: a.source,
        createdAt: a.createdAt,
      })),
    };
  },
});
