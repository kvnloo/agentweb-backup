import { emmaToolRegistry } from './registry';
import { orgDb } from '../services/db';
import { callerOrg } from './orgCaller';
import {
  configOf, effectiveLeadTypes, isLeadTypes, LEAD_ORIGINS, LEAD_ORIGIN_DESCRIPTIONS,
  type LeadNotificationsConfig,
} from '../services/leadNotificationConfig';

function settings(config?: LeadNotificationsConfig) {
  return {
    leadTypes: [...effectiveLeadTypes(config || {})],
    availableOptions: LEAD_ORIGINS.map(value => ({ value, description: LEAD_ORIGIN_DESCRIPTIONS[value] })),
    enabled: config?.enabled ?? false,
    channel: config?.slackChannelId ?? null,
    mentions: config?.mentions ?? [],
    sources: config?.sources ?? null,
    maskPhone: config?.maskPhone ?? false,
  };
}

function validateArgs(args: unknown, allowed: string[]): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error('Invalid lead notification settings arguments');
  }
}

emmaToolRegistry.register({
  name: 'get_lead_notification_settings',
  definition: {
    name: 'get_lead_notification_settings',
    description: 'Read your organization’s Slack lead notification settings and available lead types. Defaults to inbound form fills and bookings. Read first for “also notify me about LinkedIn leads”, then preserve the current types and add linkedin with update_lead_notification_settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: any) => {
    validateArgs(args, []);
    return readLeadNotificationSettings(context);
  },
});

/**
 * The settings view. `requireConfigure` (set by the MCP route, ENG-2840 W2-6a) additionally requires org:configure, as the hot-lead call
 * settings read does: the view holds Slack channel and user ids. Emma's own tool does not set it and behaves as before.
 */
export async function readLeadNotificationSettings(context: any, options: { requireConfigure?: boolean } = {}) {
  const org = await callerOrg(context, 'lead notification settings', options.requireConfigure === true);
  const config = configOf(org.leadNotifications);
  if (org.leadNotifications !== undefined && !config) throw new Error('Stored lead notification settings are invalid');
  return { success: true, ...settings(config) };
}

emmaToolRegistry.register({
  name: 'update_lead_notification_settings',
  definition: {
    name: 'update_lead_notification_settings',
    description: 'Set which leads notify your organization’s configured Slack channel (org owners/admins only). leadTypes, when given, replaces the entire list: “only form fills” = ["form_fill"]; “also notify me about LinkedIn leads” = read current settings, then add "linkedin". Omit leadTypes to keep the current selection — to turn notifications off or back on, send only enabled (omit leadTypes) so the selection is still there when they are re-enabled. An empty list silences every lead type while notifications stay on. Optionally replace Slack user mentions. Channel, sources, and phone masking are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        leadTypes: { type: 'array', items: { type: 'string', enum: [...LEAD_ORIGINS] }, uniqueItems: true, maxItems: LEAD_ORIGINS.length },
        enabled: { type: 'boolean' },
        mentions: { type: 'array', items: { type: 'string', pattern: '^[UW][A-Z0-9]+$' }, maxItems: 50 },
      },
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: any) => {
    validateArgs(args, ['leadTypes', 'enabled', 'mentions']);
    // Models often send null for omitted optionals; treat null as "not provided".
    if (args.enabled === null) delete args.enabled;
    if (args.mentions === null) delete args.mentions;
    if (args.leadTypes === null) delete args.leadTypes;
    if (args.leadTypes === undefined && args.enabled === undefined && args.mentions === undefined) {
      throw new Error('Invalid lead notification settings arguments: provide leadTypes, enabled, or mentions');
    }
    if ((args.leadTypes !== undefined && !isLeadTypes(args.leadTypes)) || (args.enabled !== undefined && typeof args.enabled !== 'boolean')) {
      throw new Error('Invalid lead types or enabled flag');
    }
    const org = await callerOrg(context, 'lead notification settings', true);
    const previous = org.leadNotifications;
    const config = configOf(previous);
    if (!config) throw new Error('Configure a valid Slack lead notification channel for this organization first');
    const updated = {
      ...config,
      // Omitted leadTypes keeps the stored selection (or the implicit default).
      ...(args.leadTypes !== undefined ? { leadTypes: args.leadTypes } : {}),
      ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      ...(args.mentions !== undefined ? { mentions: args.mentions } : {}),
    };
    const validated = configOf(updated);
    if (!validated) throw new Error('Invalid lead notification settings or Slack mentions');
    // Preserve unrelated options and fail rather than overwrite a concurrent settings edit.
    await orgDb.updateOrg(org.orgId, { leadNotifications: validated }, { condition: {
      expression: '#previousNotifications = :previousNotifications',
      names: { '#previousNotifications': 'leadNotifications' },
      values: { ':previousNotifications': previous },
    } });
    return { success: true, ...settings(validated) };
  },
});
