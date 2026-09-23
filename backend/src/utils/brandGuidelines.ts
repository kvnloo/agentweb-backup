import { randomUUID } from 'crypto';

/** Deterministic, fill-only projection of existing strategy/onboarding facts. */
export const CORE_BRAND_FIELDS = [
  'brandName', 'domain', 'tagline', 'valueProposition', 'targetAudience', 'toneOfVoice', 'keyMessages',
] as const;

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim().slice(0, 300) : '';
const first = (...values: unknown[]): string => values.map(text).find(Boolean) || '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
export const isEmptyBrandField = (value: unknown): boolean =>
  value == null || (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

export function emptyBrandFields(guidelines: unknown): string[] {
  const data = record(record(guidelines).brandData);
  return CORE_BRAND_FIELDS.filter(key => isEmptyBrandField(data[key]));
}

export function fillEmptyBrandGuidelines(existing: unknown, strategy: unknown, onboarding: unknown) {
  const brand = record(existing);
  const data = record(brand.brandData);
  const market = record(strategy);
  const source = record(onboarding);
  const overview = record(market.businessOverview);
  const candidates: Record<string, string | string[]> = {
    brandName: first(market.brandName, market.companyName, overview.companyName, source.companyName),
    domain: first(market.domain, overview.domain, source.productDomain, source.companyUrl),
    tagline: first(market.tagline, overview.tagline, source.tagline),
    valueProposition: first(market.valueProposition, overview.valueProposition, source.valueProposition),
    targetAudience: first(market.targetAudience, overview.targetAudience, source.targetAudience),
    toneOfVoice: first(market.toneOfVoice, overview.toneOfVoice, source.toneOfVoice),
    keyMessages: [market.keyMessages, overview.keyMessages, source.keyMessages]
      .map(strings).find(values => values.length > 0) || [],
  };
  const patch = Object.fromEntries(Object.entries(candidates)
    .filter(([key, value]) => isEmptyBrandField(data[key]) && !isEmptyBrandField(value)));
  if (!Object.keys(patch).length) return { guidelines: brand, filledFields: [] as string[] };
  const now = new Date().toISOString();
  // Match the canonical brand shape on first creation; do not fabricate copy
  // or apply visual defaults over an existing brand.
  const initialData = brand.brandData ? {} : {
    brandName: '', tagline: '', domain: '', valueProposition: '', primaryColor: '',
    primaryColorEnd: '', secondaryColor: '', fontFamily: '', toneOfVoice: '',
    keyMessages: [], brandValues: [], targetAudience: '', brandPersonality: '',
    isGradient: false, founders: [],
  };
  return {
    guidelines: { ...brand, brandData: { ...initialData, ...data, ...patch }, attachments: brand.attachments ?? [],
      createdAt: brand.createdAt ?? now, updatedAt: now, rev: randomUUID() },
    filledFields: Object.keys(patch),
  };
}

/** Translate the MCP contract into the brand route's partial-update contract. */
export function mapManageBrandUpdate(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const mapping = { company_name: 'brandName', mission: 'valueProposition', tone_of_voice: 'toneOfVoice',
    target_audience: 'targetAudience', key_messages: 'keyMessages' };
  for (const [from, to] of Object.entries(mapping)) {
    if (args[from] !== undefined) body[to] = args[from];
  }
  const visual = record(args.visual_identity);
  for (const key of ['primaryColor', 'primaryColorEnd', 'secondaryColor', 'fontFamily', 'isGradient']) {
    if (visual[key] !== undefined) body[key] = visual[key];
  }
  return body;
}
