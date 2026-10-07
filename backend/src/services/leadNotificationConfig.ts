/** Server-assigned provenance, separate from untrusted lead/form fields. */
export const LEAD_ORIGINS = ['form_fill', 'booking', 'linkedin', 'enrichment_import', 'manual', 'integration'] as const;
export type LeadOrigin = typeof LEAD_ORIGINS[number];
export const DEFAULT_LEAD_TYPES: readonly LeadOrigin[] = ['form_fill', 'booking'];
export const LEAD_ORIGIN_DESCRIPTIONS: Record<LeadOrigin, string> = {
  form_fill: 'Inbound landing-page forms and accepted repeat form submissions.',
  booking: 'Calendly bookings that create a lead.',
  linkedin: 'LinkedIn discovery and invitation mirror leads.',
  enrichment_import: 'Batch imports, enrichment, and Emma find-leads/list building.',
  manual: 'Single leads added through the CRM UI or API.',
  integration: 'CRM integrations, onboarding sync, signup auto-enrollment, and other syncs.',
};
export const isLeadOrigin = (value: unknown): value is LeadOrigin =>
  typeof value === 'string' && (LEAD_ORIGINS as readonly string[]).includes(value);
export const isLeadTypes = (value: unknown): value is LeadOrigin[] =>
  Array.isArray(value) && value.length <= LEAD_ORIGINS.length && value.every(isLeadOrigin) && new Set(value).size === value.length;
export const effectiveLeadTypes = (config: Pick<LeadNotificationsConfig, 'leadTypes'>): readonly LeadOrigin[] =>
  config.leadTypes ?? DEFAULT_LEAD_TYPES;
export const allowsLeadOrigin = (config: LeadNotificationsConfig, origin: unknown): boolean =>
  isLeadOrigin(origin) && effectiveLeadTypes(config).includes(origin);

export interface LeadNotificationsConfig {
  enabled: boolean;
  leadTypes?: LeadOrigin[];
  slackChannelId: string;
  /** Case-insensitive persisted list IDs/names or LP/source identifiers; absent means all. */
  sources?: string[];
  maskPhone?: boolean;
  /** Slack user IDs, not arbitrary mrkdwn. */
  mentions?: string[];
  /** Deprecated; only noemail+*@waterheater.app placeholders are hidden. */
  excludeEmailPatterns?: string[];
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim().length > 0);
export function configOf(value: unknown): LeadNotificationsConfig | undefined {
  if (!record(value) || typeof value.enabled !== 'boolean' || (value.maskPhone !== undefined && typeof value.maskPhone !== 'boolean') ||
      typeof value.slackChannelId !== 'string' || !/^[CG][A-Z0-9]+$/.test(value.slackChannelId)) return;
  for (const field of ['sources', 'mentions', 'excludeEmailPatterns']) {
    if (value[field] !== undefined && (!strings(value[field]) || value[field].length > 50 || value[field].some((entry: string) => entry.length > 254))) return;
  }
  if (value.mentions?.some((id: string) => !/^[UW][A-Z0-9]+$/.test(id))) return;
  if (value.leadTypes !== undefined && !isLeadTypes(value.leadTypes)) return;
  return value as unknown as LeadNotificationsConfig;
}
