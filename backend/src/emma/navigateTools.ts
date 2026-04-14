import { emmaToolRegistry } from './registry';

/**
 * Destination → portal path mapping.
 * Keeping this explicit (rather than accepting raw paths) limits Emma
 * to safe, known destinations and gives us a readable enum in the tool schema.
 */
const DESTINATIONS: Record<string, string> = {
  connected_accounts: '/settings/accounts',
};

emmaToolRegistry.register({
  name: 'navigate_to',
  definition: {
    name: 'navigate_to',
    description:
      'Navigate the user to a specific page in the portal. ' +
      'Use this for general page navigation only. ' +
      'Do NOT use this to connect accounts — use the connect_account tool instead, ' +
      'which lets the user authorize without leaving the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          enum: ['connected_accounts'],
          description:
            'Where to navigate. ' +
            '"connected_accounts" → Settings → Connected Accounts page.',
        },
        platform: {
          type: 'string',
          enum: ['linkedin', 'unipile', 'linkedin_ads', 'meta', 'instagram', 'gmail', 'youtube', 'fathom'],
          description:
            'Optional. Highlight a specific platform card after navigating ' +
            'so the user knows exactly which button to click.',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation of why we are navigating there (shown to user).',
        },
      },
      required: ['destination'],
    },
  },
  execute: async (args: { destination?: string; platform?: string; reason?: string }) => {
    // Default to connected_accounts — it's the only supported destination and the
    // model sometimes omits the required field despite the schema.
    const dest = args.destination ?? 'connected_accounts';
    const path = DESTINATIONS[dest] ?? DESTINATIONS['connected_accounts'];
    return {
      type: 'navigation',
      path,
      platform: args.platform,
      reason: args.reason,
    };
  },
});
