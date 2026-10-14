export interface LeadFitFilter {
  enabled: boolean;
  minUnitsDisqualifiers?: string[];
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const keyOf = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const PROPERTY = /property|properties|realty|real[\s._-]*estate|management|mgmt|apartments|homes|residential|leasing|rentals|housing|communities|living|estates|multifamily|investments|capital|group|\b(?:pm|hoa)\b/i;
const FREE_EMAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|proton|protonmail|mail|gmx)\./i;

/** Notification-only heuristic. Never mutates the lead or evaluates free-text messages/attribution. */
export function collectLeadFitHints(
  lead: { company?: unknown; website?: unknown; url?: unknown; email?: unknown; customFields?: unknown },
  config?: LeadFitFilter,
): { reasons: string[] } {
  if (!config?.enabled) return { reasons: [] };
  const custom = lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields)
    ? lead.customFields as Record<string, unknown> : {};
  const entries = Object.entries(custom);
  const disqualifiers = (config.minUnitsDisqualifiers ?? ['under_50']).map(v => v.trim().toLowerCase());
  const units = entries.filter(([key]) => /^(units|unitcount|numberofunits|numunits|unitsmanaged|managedunits|howmanyunitsdoyoumanage)$/.test(keyOf(key)))
    .map(([, value]) => text(value).toLowerCase()).find(value => disqualifiers.includes(value));
  const companyValues = entries.filter(([key]) => /^(company|companyname|website|url|companywebsite|companyurl|websiteurl)$/.test(keyOf(key))).map(([, value]) => text(value));
  const websiteSignal = (value: string): boolean => {
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      return PROPERTY.test(url.hostname); // Ignore query/path bait and attribution URLs.
    } catch { return false; }
  };
  const domain = text(lead.email).split('@')[1] || '';
  const signal = PROPERTY.test(text(lead.company)) ||
    entries.some(([key, value]) => /^(company|companyname)$/.test(keyOf(key)) && PROPERTY.test(text(value))) ||
    [text(lead.website), text(lead.url), ...companyValues].some(websiteSignal) ||
    (!!domain && !FREE_EMAIL.test(domain) && PROPERTY.test(domain));
  const reasons = [...(units ? [`units: ${units}`] : []), ...(!signal ? ['no property signal'] : [])];
  return { reasons };
}
