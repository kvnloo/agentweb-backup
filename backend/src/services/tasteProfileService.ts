import { createHash } from 'crypto';
import { accountMemoryDb } from './db';
import { twitterService } from './twitterService';

export const TASTE_MEMORY_PREFIX = 'taste-profile:v1:';
export const TASTE_PROFILE_SCHEMA = 'taste.profile.v1';
export const TASTE_SETTINGS_SOURCE = 'taste-settings:v1';
export const TASTE_SETTINGS_SCHEMA = 'taste.settings.v1';
export const MAX_TASTE_ITEMS = 250;
export const MAX_TASTE_TEXT_CHARS = 2000;
export const MAX_TASTE_TITLE_CHARS = 300;
export const MAX_TASTE_URL_CHARS = 2048;
export const MAX_TASTE_TAGS = 20;
export const MAX_TASTE_TAG_CHARS = 64;
export const MAX_TASTE_COLLECTION_ID_CHARS = 64;
export const MAX_TASTE_SOURCES = 16;

const MAX_PROFILE_TERMS = 12;
const MAX_PROFILE_DOMAINS = 8;
const MAX_PROFILE_SIGNALS = 8;
const MIN_AGGREGATE_TERM_FREQUENCY = 2;

const ITEM_KEYS = new Set(['id', 'url', 'title', 'text', 'creator', 'tags']);
const SENSITIVE_KEY = /(^|_)(access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie|authorization|credential|api[_-]?key)(_|$)/i;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before',
  'being', 'between', 'but', 'can', 'could', 'design', 'does', 'each', 'from',
  'have', 'into', 'just', 'more', 'most', 'not', 'only', 'other', 'our', 'out',
  'over', 'really', 'should', 'some', 'than', 'that', 'the', 'their', 'there',
  'these', 'they', 'this', 'those', 'through', 'use', 'using', 'very', 'was',
  'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'you',
  'your', 'https', 'http', 'www', 'com'
]);

const STYLE_LEXICONS: Record<string, Set<string>> = {
  minimal: new Set(['minimal', 'minimalist', 'clean', 'simple', 'subtle', 'restrained', 'whitespace']),
  motion: new Set(['motion', 'animation', 'animated', 'gsap', 'transition', 'scroll', 'spring']),
  editorial: new Set(['editorial', 'typography', 'type', 'grid', 'magazine', 'serif']),
  brutalist: new Set(['brutalist', 'brutalism', 'raw', 'industrial', 'mechanical']),
  playful: new Set(['playful', 'colorful', 'whimsical', 'joyful', 'fun']),
  dense: new Set(['dense', 'dashboard', 'data', 'information', 'terminal']),
  premium: new Set(['premium', 'luxury', 'elegant', 'refined', 'crafted', 'craft']),
  experimental: new Set(['experimental', 'novel', 'weird', 'prototype', 'spatial', 'immersive']),
};

export type TasteCollectionItem = {
  id?: string;
  url?: string;
  title?: string;
  text?: string;
  creator?: string;
  tags?: string[];
};

export type TasteSourceSnapshot = {
  schema: typeof TASTE_PROFILE_SCHEMA;
  source: 'x_bookmarks' | 'collection';
  sourceKey: string;
  itemCount: number;
  topDomains: string[];
  topTerms: string[];
  styleSignals: Array<{ name: string; score: number }>;
  generatedAt: string;
};

export type TasteProfile = {
  schema: typeof TASTE_PROFILE_SCHEMA;
  sourceCount: number;
  itemCount: number;
  sources: Array<{ source: TasteSourceSnapshot['source']; itemCount: number }>;
  topDomains: string[];
  topTerms: string[];
  styleSignals: Array<{ name: string; score: number }>;
  updatedAt: string | null;
};

export type TasteSurface =
  | 'brand'
  | 'landing_page'
  | 'image'
  | 'video'
  | 'social'
  | 'ad_creative'
  | 'editorial'
  | 'research'
  | 'reply_curation'
  | 'email'
  | 'crm'
  | 'analytics';

export type TasteIntensity = 'off' | 'subtle' | 'strong';

export type TasteSettings = {
  schema: typeof TASTE_SETTINGS_SCHEMA;
  surfaces: Record<TasteSurface, TasteIntensity>;
  updatedAt: string | null;
};

export type TasteDials = {
  designVariance: number;
  motionIntensity: number;
  visualDensity: number;
};

export const TASTE_APPLICATION_SCHEMA = 'taste.application.v1';
export const TASTE_RECEIPT_SCHEMA = 'taste.application-receipt.v1';
export const TASTE_FEEDBACK_SCHEMA = 'taste.feedback.v1';
export const TASTE_FEEDBACK_MEMORY_PREFIX = 'taste-feedback:v1:';

export type TasteResolutionSource = 'surface_default' | 'task_override';
export type TasteFeedbackDirection = 'more' | 'less' | 'ignore';
export type TasteFeedbackArtifactType = 'landing_page';

export type TasteApplicationReceipt = {
  schema: typeof TASTE_RECEIPT_SCHEMA;
  applicationSchema: typeof TASTE_APPLICATION_SCHEMA;
  surface: TasteSurface;
  active: boolean;
  intensity: TasteIntensity;
  confidence: number;
  resolutionSource: TasteResolutionSource;
  profileRevision: string;
  settingsRevision: string | null;
  dials: TasteDials;
  signals: string[];
  generatedAt: string;
};

export type TasteApplication = {
  schema: typeof TASTE_APPLICATION_SCHEMA;
  surface: TasteSurface;
  active: boolean;
  intensity: TasteIntensity;
  confidence: number;
  profile: TasteProfile;
  dials: TasteDials;
  signals: string[];
  guardrails: string[];
  promptContext: string;
  receipt: TasteApplicationReceipt;
};

export type TasteFeedbackEvent = {
  schema: typeof TASTE_FEEDBACK_SCHEMA;
  eventId: string;
  artifactType: TasteFeedbackArtifactType;
  artifactId: string;
  direction: TasteFeedbackDirection;
  receipt: TasteApplicationReceipt;
  createdAt: string;
  reversedAt?: string;
};

export const TASTE_SURFACES: readonly TasteSurface[] = [
  'brand',
  'landing_page',
  'image',
  'video',
  'social',
  'ad_creative',
  'editorial',
  'research',
  'reply_curation',
  'email',
  'crm',
  'analytics',
] as const;

const DEFAULT_SURFACE_INTENSITY: Record<TasteSurface, TasteIntensity> = {
  brand: 'subtle',
  landing_page: 'strong',
  image: 'strong',
  video: 'strong',
  social: 'subtle',
  ad_creative: 'subtle',
  editorial: 'subtle',
  research: 'subtle',
  reply_curation: 'subtle',
  email: 'off',
  crm: 'off',
  analytics: 'off',
};

const STYLE_DIAL_TARGETS: Record<string, TasteDials> = {
  minimal: { designVariance: 5, motionIntensity: 3, visualDensity: 3 },
  motion: { designVariance: 7, motionIntensity: 8, visualDensity: 4 },
  editorial: { designVariance: 6, motionIntensity: 4, visualDensity: 3 },
  brutalist: { designVariance: 8, motionIntensity: 5, visualDensity: 5 },
  playful: { designVariance: 9, motionIntensity: 8, visualDensity: 4 },
  dense: { designVariance: 6, motionIntensity: 5, visualDensity: 8 },
  premium: { designVariance: 7, motionIntensity: 6, visualDensity: 3 },
  experimental: { designVariance: 9, motionIntensity: 8, visualDensity: 4 },
};

const SURFACE_GUARDRAILS: Record<TasteSurface, string[]> = {
  brand: [
    'Treat Taste as inspiration for a brand proposal, never as permission to overwrite existing brand guidelines silently.',
    'Existing brand assets, audience, category, accessibility and explicit user direction outrank Taste.',
  ],
  landing_page: [
    'Run brief inference first: page kind, audience, existing design system, brand constraints, and accessibility outrank Taste.',
    'Use Taste to choose among valid layout, typography, material and motion options; avoid generic AI-default composition.',
    'Preserve an existing design system during redesigns unless the user explicitly asks for an overhaul.',
  ],
  image: [
    'Use Taste for art direction, composition, materiality and visual rhythm, not for inventing facts, logos or product claims.',
    'Explicit source images, persisted brand assets and the user prompt outrank Taste.',
  ],
  video: [
    'Use Taste for pacing, framing, typography, transitions and visual world.',
    'Story requirements, source media continuity, accessibility and brand assets outrank Taste.',
  ],
  social: [
    'Use Taste for angle, rhythm, specificity and presentation; platform-native formatting and brand voice outrank Taste.',
    'Do not turn aesthetic preference into fabricated claims or engagement predictions.',
  ],
  ad_creative: [
    'Performance evidence, offer clarity, platform policy, compliance and brand constraints outrank Taste.',
    'Use Taste only as a creative prior for visual/copy variants; keep performance learning separate from aesthetic preference.',
  ],
  editorial: [
    'Use Taste for structure, pacing, examples and visual/editorial character while preserving factual accuracy and citations.',
    'Explicit voice/brand guidance outranks Taste.',
  ],
  research: [
    'Taste may rank examples, references and presentation style only; it must never change factual findings, source quality or uncertainty.',
    'Do not filter out disconfirming evidence because it conflicts with preference.',
  ],
  reply_curation: [
    'Taste may help rank which posts feel relevant or worth responding to, but freshness, completeness and user intent outrank it.',
    'Never fabricate a candidate to satisfy Taste.',
  ],
  email: [
    'Taste is off by default for email. Use explicit voice/brand guidance instead unless the user opts in for this task.',
  ],
  crm: [
    'Taste is off by default for CRM facts, lifecycle, enrichment, scoring and mutations.',
  ],
  analytics: [
    'Taste is off by default for measurements, attribution, reporting and diagnosis.',
  ],
};

type MemoryRecord = {
  memoryId: string;
  category?: string;
  content?: string;
  sourceSessionId?: string;
  updatedAt?: string;
  createdAt?: string;
};

export type TasteMemoryStore = {
  getUserMemories(userId: string, category?: string, limit?: number): Promise<MemoryRecord[]>;
  addMemory(
    userId: string,
    category: string,
    content: string,
    sourceSessionId?: string
  ): Promise<Record<string, any>>;
  updateMemory(
    userId: string,
    memoryId: string,
    updates: { content?: string; category?: string }
  ): Promise<Record<string, any> | undefined>;
  deleteMemory(userId: string, memoryId: string): Promise<void>;
};

export type TasteXBookmarkReader = {
  getBookmarks(userId: string, accountId: string): Promise<any[]>;
};

export class TasteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TasteValidationError';
  }
}

export class TasteSourceAccessError extends Error {
  constructor(message = 'Connected source is not available for this user') {
    super(message);
    this.name = 'TasteSourceAccessError';
  }
}

export class TasteProviderError extends Error {
  constructor(message = 'Unable to import from the connected source') {
    super(message);
    this.name = 'TasteProviderError';
  }
}

export class TasteFeedbackNotFoundError extends Error {
  constructor(message = 'Taste feedback not found') {
    super(message);
    this.name = 'TasteFeedbackNotFoundError';
  }
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TasteValidationError(`${field} must be a string`);
  const clean = value.trim();
  if (!clean) return undefined;
  if (charLength(clean) > max) {
    throw new TasteValidationError(`${field} must be ${max} characters or less`);
  }
  return clean;
}

function assertNoSensitiveKeys(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoSensitiveKeys(value[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new TasteValidationError(`${path} contains a forbidden credential field`);
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TasteValidationError('item.url must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TasteValidationError('item.url must use http or https');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString();
}

function normalizeItem(raw: unknown): TasteCollectionItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TasteValidationError('each item must be an object');
  }

  assertNoSensitiveKeys(raw, 'item');
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ITEM_KEYS.has(key)) throw new TasteValidationError(`unsupported item field: ${key}`);
  }

  let tags: string[] | undefined;
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags)) throw new TasteValidationError('item.tags must be an array');
    if (record.tags.length > MAX_TASTE_TAGS) {
      throw new TasteValidationError(`item.tags supports at most ${MAX_TASTE_TAGS} values`);
    }
    tags = Array.from(new Set(record.tags.map((tag, index) => {
      const clean = boundedString(tag, `item.tags[${index}]`, MAX_TASTE_TAG_CHARS);
      if (!clean) throw new TasteValidationError('item.tags cannot contain empty values');
      return clean;
    })));
  }

  const item: TasteCollectionItem = {
    id: boundedString(record.id, 'item.id', 256),
    url: normalizeUrl(boundedString(record.url, 'item.url', MAX_TASTE_URL_CHARS)),
    title: boundedString(record.title, 'item.title', MAX_TASTE_TITLE_CHARS),
    text: boundedString(record.text, 'item.text', MAX_TASTE_TEXT_CHARS),
    creator: boundedString(record.creator, 'item.creator', MAX_TASTE_TITLE_CHARS),
    tags,
  };

  if (!item.url && !item.title && !item.text && !item.creator && (!item.tags || item.tags.length === 0)) {
    throw new TasteValidationError('each item must contain at least one descriptive field');
  }

  return item;
}

function stableItemKey(item: TasteCollectionItem): string {
  return JSON.stringify({
    url: item.url || '',
    title: item.title || '',
    text: item.text || '',
    creator: item.creator || '',
    tags: item.tags || [],
  });
}

function normalizeItems(rawItems: unknown): TasteCollectionItem[] {
  if (!Array.isArray(rawItems)) throw new TasteValidationError('items must be an array');
  if (rawItems.length === 0) throw new TasteValidationError('items cannot be empty');
  if (rawItems.length > MAX_TASTE_ITEMS) {
    throw new TasteValidationError(`items supports at most ${MAX_TASTE_ITEMS} entries`);
  }

  const deduped = new Map<string, TasteCollectionItem>();
  for (const raw of rawItems) {
    const item = normalizeItem(raw);
    deduped.set(stableItemKey(item), item);
  }
  return Array.from(deduped.values());
}

function extractTweetItems(bookmarks: any[]): TasteCollectionItem[] {
  if (!Array.isArray(bookmarks)) throw new TasteProviderError();
  const bounded = bookmarks.slice(0, MAX_TASTE_ITEMS);
  const items: TasteCollectionItem[] = [];

  for (const bookmark of bounded) {
    if (!bookmark || typeof bookmark !== 'object') continue;
    const rawText = typeof bookmark.text === 'string' ? bookmark.text : undefined;
    const text = rawText
      ? boundedString(rawText, 'bookmark.text', MAX_TASTE_TEXT_CHARS)
      : undefined;

    const urls: string[] = [];
    const entityUrls = bookmark?.entities?.urls;
    if (Array.isArray(entityUrls)) {
      for (const entity of entityUrls.slice(0, 8)) {
        const candidate =
          typeof entity?.expanded_url === 'string' ? entity.expanded_url :
          typeof entity?.unwound_url === 'string' ? entity.unwound_url :
          typeof entity?.url === 'string' ? entity.url :
          undefined;
        if (!candidate) continue;
        try {
          const normalized = normalizeUrl(candidate);
          if (normalized) urls.push(normalized);
        } catch {
          // Provider data can contain shortened/non-standard URL values. Ignore rather
          // than widening the input contract or persisting raw provider content.
        }
      }
    }

    if (!text && urls.length === 0) continue;
    items.push({ text, url: urls[0] });
  }

  if (items.length === 0) {
    throw new TasteValidationError('No usable bookmarks were returned by the connected X account');
  }
  return normalizeItems(items);
}

function tokenize(items: TasteCollectionItem[]): string[] {
  const joined = items
    .flatMap((item) => [item.title, item.text, item.creator, ...(item.tags || [])])
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();

  return (joined.match(/[a-z][a-z0-9-]{2,}/g) || [])
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && token.length <= 40 && !STOP_WORDS.has(token));
}

function countTop(values: string[], limit: number, minCount = 1): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function domainOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function snapshotFor(
  source: TasteSourceSnapshot['source'],
  sourceKey: string,
  items: TasteCollectionItem[]
): TasteSourceSnapshot {
  const tokens = tokenize(items);
  const tokenCounts = new Map<string, number>();
  for (const token of tokens) tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);

  const styleRaw = Object.entries(STYLE_LEXICONS)
    .map(([name, lexicon]) => {
      let count = 0;
      for (const word of lexicon) count += tokenCounts.get(word) || 0;
      return { name, count };
    })
    .filter((signal) => signal.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_PROFILE_SIGNALS);

  const totalStyleHits = styleRaw.reduce((sum, signal) => sum + signal.count, 0) || 1;
  const styleSignals = styleRaw.map((signal) => ({
    name: signal.name,
    score: Math.round((signal.count / totalStyleHits) * 1000) / 1000,
  }));

  const domains = items.map((item) => domainOf(item.url)).filter((value): value is string => Boolean(value));
  return {
    schema: TASTE_PROFILE_SCHEMA,
    source,
    sourceKey,
    itemCount: items.length,
    // Like terms, retain a domain only after repeated evidence so a one-off private
    // source does not become durable preference context.
    topDomains: countTop(domains, MAX_PROFILE_DOMAINS, MIN_AGGREGATE_TERM_FREQUENCY).map((entry) => entry.value),
    // A term must occur at least twice before it is retained. This avoids turning a
    // one-off private bookmark phrase into durable memory.
    topTerms: countTop(tokens, MAX_PROFILE_TERMS, MIN_AGGREGATE_TERM_FREQUENCY).map((entry) => entry.value),
    styleSignals,
    generatedAt: new Date().toISOString(),
  };
}

function encodeSnapshot(snapshot: TasteSourceSnapshot): string {
  // Account Memory has a 2,000-code-point contract. The snapshot contains only bounded
  // aggregate metadata and is intentionally compact so it remains well below that cap.
  return `Taste Profile aggregate (raw source content intentionally not retained): ${JSON.stringify(snapshot)}`;
}

function decodeSnapshot(memory: MemoryRecord): TasteSourceSnapshot | null {
  if (!memory.sourceSessionId?.startsWith(TASTE_MEMORY_PREFIX) || typeof memory.content !== 'string') {
    return null;
  }
  const marker = memory.content.indexOf('{');
  if (marker < 0) return null;
  try {
    const parsed = JSON.parse(memory.content.slice(marker));
    if (
      parsed?.schema !== TASTE_PROFILE_SCHEMA ||
      (parsed?.source !== 'x_bookmarks' && parsed?.source !== 'collection') ||
      typeof parsed?.sourceKey !== 'string' ||
      !Number.isInteger(parsed?.itemCount)
    ) {
      return null;
    }
    return parsed as TasteSourceSnapshot;
  } catch {
    return null;
  }
}

function aggregateSnapshots(snapshots: TasteSourceSnapshot[]): TasteProfile {
  const domainValues = snapshots.flatMap((snapshot) => snapshot.topDomains);
  const termValues = snapshots.flatMap((snapshot) => snapshot.topTerms);
  const styleTotals = new Map<string, number>();

  for (const snapshot of snapshots) {
    for (const signal of snapshot.styleSignals) {
      styleTotals.set(signal.name, (styleTotals.get(signal.name) || 0) + signal.score * snapshot.itemCount);
    }
  }

  const totalWeight = Array.from(styleTotals.values()).reduce((sum, value) => sum + value, 0) || 1;
  const styleSignals = Array.from(styleTotals.entries())
    .map(([name, value]) => ({ name, score: Math.round((value / totalWeight) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_PROFILE_SIGNALS);

  const sortedTimestamps = snapshots
    .map((snapshot) => snapshot.generatedAt)
    .sort();
  const updatedAt = sortedTimestamps.length > 0
    ? sortedTimestamps[sortedTimestamps.length - 1]
    : null;

  const sourceCounts = new Map<TasteSourceSnapshot['source'], number>();
  for (const snapshot of snapshots) {
    sourceCounts.set(snapshot.source, (sourceCounts.get(snapshot.source) || 0) + snapshot.itemCount);
  }

  return {
    schema: TASTE_PROFILE_SCHEMA,
    sourceCount: snapshots.length,
    itemCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
    sources: Array.from(sourceCounts.entries())
      .map(([source, itemCount]) => ({ source, itemCount }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    topDomains: countTop(domainValues, MAX_PROFILE_DOMAINS).map((entry) => entry.value),
    topTerms: countTop(termValues, MAX_PROFILE_TERMS).map((entry) => entry.value),
    styleSignals,
    updatedAt,
  };
}


function clampDial(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value * 10) / 10));
}

function deriveTasteDials(profile: TasteProfile): TasteDials {
  if (profile.styleSignals.length === 0) {
    // Taste Skill's mainstream marketing baseline, kept intentionally moderate
    // until the user profile contains repeated evidence.
    return { designVariance: 7, motionIntensity: 5, visualDensity: 4 };
  }

  let weight = 0;
  let designVariance = 0;
  let motionIntensity = 0;
  let visualDensity = 0;

  for (const signal of profile.styleSignals) {
    const target = STYLE_DIAL_TARGETS[signal.name];
    if (!target || !Number.isFinite(signal.score) || signal.score <= 0) continue;
    weight += signal.score;
    designVariance += target.designVariance * signal.score;
    motionIntensity += target.motionIntensity * signal.score;
    visualDensity += target.visualDensity * signal.score;
  }

  if (weight <= 0) {
    return { designVariance: 7, motionIntensity: 5, visualDensity: 4 };
  }

  return {
    designVariance: clampDial(designVariance / weight),
    motionIntensity: clampDial(motionIntensity / weight),
    visualDensity: clampDial(visualDensity / weight),
  };
}

function validateTasteSurface(surface: unknown): TasteSurface {
  if (typeof surface !== 'string' || !TASTE_SURFACES.includes(surface as TasteSurface)) {
    throw new TasteValidationError(
      `surface must be one of: ${TASTE_SURFACES.join(', ')}`
    );
  }
  return surface as TasteSurface;
}

function validateTasteIntensity(intensity: unknown): TasteIntensity | undefined {
  if (intensity === undefined || intensity === null || intensity === '') return undefined;
  if (intensity !== 'off' && intensity !== 'subtle' && intensity !== 'strong') {
    throw new TasteValidationError('intensity must be one of: off, subtle, strong');
  }
  return intensity;
}

function stableTasteRevision(prefix: 'profile' | 'settings', value: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
  return `${prefix}:v1:${digest}`;
}

function tasteProfileRevision(profile: TasteProfile): string {
  const { updatedAt: _updatedAt, ...stableProfile } = profile;
  return stableTasteRevision('profile', stableProfile);
}

function tasteSettingsRevision(settings: TasteSettings): string {
  return stableTasteRevision('settings', {
    schema: settings.schema,
    surfaces: TASTE_SURFACES.map((surface) => [surface, settings.surfaces[surface]]),
  });
}

function buildTasteApplication(
  profile: TasteProfile,
  rawSurface: unknown,
  rawIntensity?: unknown,
  receiptContext: {
    resolutionSource?: TasteResolutionSource;
    settings?: TasteSettings | null;
    generatedAt?: string;
  } = {}
): TasteApplication {
  const surface = validateTasteSurface(rawSurface);
  const requestedIntensity = validateTasteIntensity(rawIntensity);
  const intensity = requestedIntensity || DEFAULT_SURFACE_INTENSITY[surface];
  const dials = deriveTasteDials(profile);
  const guardrails = SURFACE_GUARDRAILS[surface];
  const active = intensity !== 'off' && profile.sourceCount > 0 && profile.itemCount > 0;
  const confidence = active
    ? Math.round(Math.min(1, profile.itemCount / 20) * 1000) / 1000
    : 0;
  const signals = profile.styleSignals
    .slice(0, MAX_PROFILE_SIGNALS)
    .map((signal) => `${signal.name}:${signal.score}`);
  const resolutionSource = receiptContext.resolutionSource
    || (requestedIntensity ? 'task_override' : 'surface_default');
  const receiptSettings = resolutionSource === 'surface_default'
    ? (receiptContext.settings || defaultTasteSettings())
    : null;
  const receipt: TasteApplicationReceipt = {
    schema: TASTE_RECEIPT_SCHEMA,
    applicationSchema: TASTE_APPLICATION_SCHEMA,
    surface,
    active,
    intensity,
    confidence,
    resolutionSource,
    profileRevision: tasteProfileRevision(profile),
    settingsRevision: receiptSettings ? tasteSettingsRevision(receiptSettings) : null,
    dials: { ...dials },
    signals: [...signals],
    generatedAt: receiptContext.generatedAt || new Date().toISOString(),
  };

  if (!active) {
    return {
      schema: TASTE_APPLICATION_SCHEMA,
      surface,
      active: false,
      intensity,
      confidence,
      profile,
      dials,
      signals,
      guardrails,
      promptContext: '',
      receipt,
    };
  }

  const strength = intensity === 'strong'
    ? 'Use these preferences as a strong creative prior when several choices satisfy the brief.'
    : 'Use these preferences as a light tie-breaker between choices that already satisfy the brief.';

  const designRules =
    surface === 'landing_page' || surface === 'image' || surface === 'video' || surface === 'brand'
      ? [
          'Apply the Taste Skill process: infer the brief before styling, then use the three dials below.',
          'Actively avoid generic AI-default composition; choose an intentional design system/aesthetic family that fits the brief.',
          'Do a final anti-slop/pre-flight check for hierarchy, layout, motion, accessibility and implementation clarity.',
        ]
      : [];

  const contextLines = [
    'TASTE CONTEXT — preference, not requirement; raw source content is intentionally unavailable.',
    `surface=${surface}; intensity=${intensity}; confidence=${confidence}`,
    `dials: DESIGN_VARIANCE=${dials.designVariance}/10; MOTION_INTENSITY=${dials.motionIntensity}/10; VISUAL_DENSITY=${dials.visualDensity}/10`,
    profile.styleSignals.length
      ? `style signals: ${profile.styleSignals.map((signal) => signal.name).join(', ')}`
      : '',
    profile.topTerms.length ? `recurring preference terms: ${profile.topTerms.join(', ')}` : '',
    profile.topDomains.length ? `recurring reference domains: ${profile.topDomains.join(', ')}` : '',
    strength,
    ...designRules,
    ...guardrails,
    'Never mention or reconstruct private source items from these aggregates.',
  ].filter(Boolean);

  return {
    schema: TASTE_APPLICATION_SCHEMA,
    surface,
    active: true,
    intensity,
    confidence,
    profile,
    dials,
    signals,
    guardrails,
    promptContext: contextLines.join('\n'),
    receipt,
  };
}


function defaultTasteSettings(): TasteSettings {
  return {
    schema: TASTE_SETTINGS_SCHEMA,
    surfaces: { ...DEFAULT_SURFACE_INTENSITY },
    updatedAt: null,
  };
}

function decodeTasteSettings(memory: MemoryRecord | undefined): TasteSettings | null {
  if (!memory || memory.sourceSessionId !== TASTE_SETTINGS_SOURCE || typeof memory.content !== 'string') {
    return null;
  }
  const marker = memory.content.indexOf('{');
  if (marker < 0) return null;
  try {
    const parsed = JSON.parse(memory.content.slice(marker));
    if (parsed?.schema !== TASTE_SETTINGS_SCHEMA || !parsed?.surfaces || typeof parsed.surfaces !== 'object') {
      return null;
    }
    const surfaces = { ...DEFAULT_SURFACE_INTENSITY };
    for (const surface of TASTE_SURFACES) {
      const value = parsed.surfaces[surface];
      if (value === 'off' || value === 'subtle' || value === 'strong') surfaces[surface] = value;
    }
    return {
      schema: TASTE_SETTINGS_SCHEMA,
      surfaces,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : (memory.updatedAt || null),
    };
  } catch {
    return null;
  }
}

function normalizeTasteSettingsPatch(raw: unknown): Partial<Record<TasteSurface, TasteIntensity>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TasteValidationError('surfaces must be an object');
  }
  const patch: Partial<Record<TasteSurface, TasteIntensity>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const surface = validateTasteSurface(key);
    const intensity = validateTasteIntensity(value);
    if (!intensity) throw new TasteValidationError(`intensity is required for ${surface}`);
    patch[surface] = intensity;
  }
  return patch;
}

function encodeTasteSettings(settings: TasteSettings): string {
  return `Taste Settings: ${JSON.stringify(settings)}`;
}

function sourceMemoryId(sourceKey: string): string {
  return `${TASTE_MEMORY_PREFIX}${sourceKey}`;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function validateFeedbackDirection(value: unknown): TasteFeedbackDirection {
  if (value === 'more' || value === 'less' || value === 'ignore') return value;
  throw new TasteValidationError('direction must be more, less, or ignore');
}

function validateFeedbackArtifactType(value: unknown): TasteFeedbackArtifactType {
  if (value === 'landing_page') return value;
  throw new TasteValidationError('artifactType must be landing_page');
}

function feedbackSourceMemoryId(artifactType: TasteFeedbackArtifactType, artifactId: string): string {
  return `${TASTE_FEEDBACK_MEMORY_PREFIX}${hashKey(`${artifactType}:${artifactId}`)}`;
}

function encodeTasteFeedback(event: Omit<TasteFeedbackEvent, 'eventId'>): string {
  return `Taste Feedback (explicit user action; not performance data): ${JSON.stringify(event)}`;
}

function decodeTasteFeedback(memory: MemoryRecord): TasteFeedbackEvent | null {
  if (!memory.sourceSessionId?.startsWith(TASTE_FEEDBACK_MEMORY_PREFIX) || typeof memory.content !== 'string') {
    return null;
  }
  const marker = memory.content.indexOf('{');
  if (marker < 0) return null;
  try {
    const parsed = JSON.parse(memory.content.slice(marker));
    if (
      parsed?.schema !== TASTE_FEEDBACK_SCHEMA ||
      parsed?.artifactType !== 'landing_page' ||
      typeof parsed?.artifactId !== 'string' ||
      !['more', 'less', 'ignore'].includes(parsed?.direction) ||
      parsed?.receipt?.schema !== TASTE_RECEIPT_SCHEMA ||
      parsed?.receipt?.applicationSchema !== TASTE_APPLICATION_SCHEMA ||
      typeof parsed?.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      ...parsed,
      eventId: memory.memoryId,
    } as TasteFeedbackEvent;
  } catch {
    return null;
  }
}

function parseReceiptSignal(signal: string): { name: string; score: number } | null {
  const splitAt = signal.lastIndexOf(':');
  if (splitAt <= 0) return null;
  const name = signal.slice(0, splitAt);
  const score = Number(signal.slice(splitAt + 1));
  if (!STYLE_DIAL_TARGETS[name] || !Number.isFinite(score) || score <= 0) return null;
  return { name, score };
}

/**
 * Explicit feedback is a bounded preference correction, never performance data.
 * Accumulate deltas before clamping so opposite events cancel independent of
 * DynamoDB return order. Reversed and Ignore events remain auditable but inert.
 */
function applyTasteFeedback(profile: TasteProfile, events: TasteFeedbackEvent[]): TasteProfile {
  const deltas = new Map<string, number>();
  const FEEDBACK_STEP = 0.25;

  for (const event of events) {
    if (event.reversedAt || event.direction === 'ignore') continue;
    const sign = event.direction === 'more' ? 1 : -1;
    for (const rawSignal of event.receipt.signals || []) {
      const signal = parseReceiptSignal(rawSignal);
      if (!signal) continue;
      // Reinforce/attenuate the artifact's strongest effective signals more than
      // weak incidental ones. Squaring preserves ordering and lets + / - events
      // cancel exactly before normalization.
      deltas.set(
        signal.name,
        (deltas.get(signal.name) || 0) + sign * FEEDBACK_STEP * signal.score * signal.score
      );
    }
  }

  if (deltas.size === 0) return profile;

  const weights = new Map(profile.styleSignals.map((signal) => [signal.name, signal.score]));
  for (const [name, delta] of deltas) {
    weights.set(name, Math.max(0, (weights.get(name) || 0) + delta));
  }

  const total = Array.from(weights.values()).reduce((sum, value) => sum + value, 0);
  const styleSignals = total > 0
    ? Array.from(weights.entries())
        .filter(([, value]) => value > 0)
        .map(([name, value]) => ({ name, score: Math.round((value / total) * 1000) / 1000 }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, MAX_PROFILE_SIGNALS)
    : [];

  const feedbackTimestamps = events
    .flatMap((event) => [event.createdAt, event.reversedAt].filter((value): value is string => Boolean(value)))
    .sort();
  const latestFeedbackAt = feedbackTimestamps.length > 0
    ? feedbackTimestamps[feedbackTimestamps.length - 1]
    : null;
  const allTimestamps = [profile.updatedAt, latestFeedbackAt]
    .filter((value): value is string => Boolean(value))
    .sort();
  const updatedAt = allTimestamps.length > 0
    ? allTimestamps[allTimestamps.length - 1]
    : null;

  return { ...profile, styleSignals, updatedAt };
}

export class TasteProfileService {
  constructor(
    private readonly xReader: TasteXBookmarkReader = twitterService,
    private readonly memoryStore: TasteMemoryStore = accountMemoryDb
  ) {}

  async importXBookmarks(userId: string, accountId: unknown): Promise<TasteProfile> {
    const cleanAccountId = boundedString(accountId, 'accountId', 256);
    if (!cleanAccountId) throw new TasteValidationError('accountId is required');

    let bookmarks: any[];
    try {
      bookmarks = await this.xReader.getBookmarks(userId, cleanAccountId);
    } catch (error: any) {
      // Preserve tenant privacy: a missing ID and another user's ID have the same response.
      if (/No twitter account with id/i.test(String(error?.message || ''))) {
        throw new TasteSourceAccessError();
      }
      throw new TasteProviderError('Unable to read bookmarks from the connected X account');
    }

    const items = extractTweetItems(bookmarks);
    const key = `x-${hashKey(cleanAccountId)}`;
    await this.saveSnapshot(userId, snapshotFor('x_bookmarks', key, items));
    return this.getProfile(userId);
  }

  async importCollection(
    userId: string,
    rawItems: unknown,
    collectionId?: unknown
  ): Promise<TasteProfile> {
    assertNoSensitiveKeys(rawItems, 'items');
    const items = normalizeItems(rawItems);
    const cleanCollectionId =
      boundedString(collectionId, 'collectionId', MAX_TASTE_COLLECTION_ID_CHARS) || 'default';
    const key = `collection-${hashKey(cleanCollectionId)}`;
    await this.saveSnapshot(userId, snapshotFor('collection', key, items));
    return this.getProfile(userId);
  }

  async getProfile(userId: string): Promise<TasteProfile> {
    const memories = await this.memoryStore.getUserMemories(userId, 'preference');
    const snapshots = memories
      .filter((memory) => memory.sourceSessionId?.startsWith(TASTE_MEMORY_PREFIX))
      .map(decodeSnapshot)
      .filter((snapshot): snapshot is TasteSourceSnapshot => Boolean(snapshot));

    return aggregateSnapshots(snapshots);
  }

  async getSettings(userId: string): Promise<TasteSettings> {
    const memories = await this.memoryStore.getUserMemories(userId, 'preference');
    const stored = decodeTasteSettings(
      memories.find((memory) => memory.sourceSessionId === TASTE_SETTINGS_SOURCE)
    );
    return stored || defaultTasteSettings();
  }

  async updateSettings(
    userId: string,
    rawSurfaces: unknown
  ): Promise<TasteSettings> {
    const patch = normalizeTasteSettingsPatch(rawSurfaces);
    const memories = await this.memoryStore.getUserMemories(userId, 'preference');
    const existing = memories.find((memory) => memory.sourceSessionId === TASTE_SETTINGS_SOURCE);
    const current = decodeTasteSettings(existing) || defaultTasteSettings();
    const settings: TasteSettings = {
      schema: TASTE_SETTINGS_SCHEMA,
      surfaces: { ...current.surfaces, ...patch },
      updatedAt: new Date().toISOString(),
    };
    const content = encodeTasteSettings(settings);
    if (charLength(content) > 2000) {
      throw new TasteValidationError('Taste settings exceeded the durable memory size limit');
    }
    if (existing) {
      await this.memoryStore.updateMemory(userId, existing.memoryId, {
        category: 'preference',
        content,
      });
    } else {
      await this.memoryStore.addMemory(
        userId,
        'preference',
        content,
        TASTE_SETTINGS_SOURCE
      );
    }
    return settings;
  }

  async getApplication(
    userId: string,
    surface: unknown,
    intensity?: unknown
  ): Promise<TasteApplication> {
    const validatedSurface = validateTasteSurface(surface);
    const explicitIntensity = validateTasteIntensity(intensity);
    const [baseProfile, feedback] = await Promise.all([
      this.getProfile(userId),
      this.listFeedback(userId),
    ]);
    // Feedback is surface-scoped: liking a landing-page treatment must not silently
    // steer research, email, or another creative surface.
    const profile = applyTasteFeedback(
      baseProfile,
      feedback.filter((event) => event.receipt.surface === validatedSurface)
    );
    const settings = explicitIntensity ? null : await this.getSettings(userId);
    const resolvedIntensity = explicitIntensity ?? settings!.surfaces[validatedSurface];
    return buildTasteApplication(profile, validatedSurface, resolvedIntensity, {
      resolutionSource: explicitIntensity ? 'task_override' : 'surface_default',
      settings,
    });
  }

  async applyToPrompt(
    userId: string,
    surface: unknown,
    prompt: string,
    intensity?: unknown
  ): Promise<{ prompt: string; application: TasteApplication }> {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new TasteValidationError('prompt is required');
    }
    const application = await this.getApplication(userId, surface, intensity);
    if (!application.active || !application.promptContext) {
      return { prompt, application };
    }
    return {
      prompt: `${prompt.trim()}\n\n${application.promptContext}`,
      application,
    };
  }

  async recordFeedback(
    userId: string,
    artifactType: unknown,
    artifactId: unknown,
    direction: unknown,
    receipt: TasteApplicationReceipt
  ): Promise<TasteFeedbackEvent> {
    const cleanArtifactType = validateFeedbackArtifactType(artifactType);
    const cleanArtifactId = boundedString(artifactId, 'artifactId', 256);
    if (!cleanArtifactId) throw new TasteValidationError('artifactId is required');
    const cleanDirection = validateFeedbackDirection(direction);
    if (
      !receipt ||
      receipt.schema !== TASTE_RECEIPT_SCHEMA ||
      receipt.applicationSchema !== TASTE_APPLICATION_SCHEMA ||
      receipt.surface !== 'landing_page'
    ) {
      throw new TasteValidationError('artifact receipt is not valid landing-page Taste provenance');
    }

    const event: Omit<TasteFeedbackEvent, 'eventId'> = {
      schema: TASTE_FEEDBACK_SCHEMA,
      artifactType: cleanArtifactType,
      artifactId: cleanArtifactId,
      direction: cleanDirection,
      // Defensive copy keeps the stored event immutable even if a caller reuses/mutates
      // its in-memory application object after this method returns.
      receipt: JSON.parse(JSON.stringify(receipt)),
      createdAt: new Date().toISOString(),
    };
    const content = encodeTasteFeedback(event);
    if (charLength(content) > 2000) {
      throw new TasteValidationError('Taste feedback exceeded the durable memory size limit');
    }
    const memory = await this.memoryStore.addMemory(
      userId,
      'history',
      content,
      feedbackSourceMemoryId(cleanArtifactType, cleanArtifactId)
    );
    return { ...event, eventId: String(memory.memoryId) };
  }

  async listFeedback(userId: string, artifactId?: unknown): Promise<TasteFeedbackEvent[]> {
    const cleanArtifactId = artifactId === undefined
      ? undefined
      : boundedString(artifactId, 'artifactId', 256);
    const memories = await this.memoryStore.getUserMemories(userId, 'history');
    return memories
      .filter((memory) => memory.sourceSessionId?.startsWith(TASTE_FEEDBACK_MEMORY_PREFIX))
      .map(decodeTasteFeedback)
      .filter((event): event is TasteFeedbackEvent => Boolean(event))
      .filter((event) => !cleanArtifactId || event.artifactId === cleanArtifactId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.eventId.localeCompare(a.eventId));
  }

  async reverseFeedback(userId: string, eventId: unknown): Promise<TasteFeedbackEvent> {
    const cleanEventId = boundedString(eventId, 'eventId', 128);
    if (!cleanEventId) throw new TasteValidationError('eventId is required');
    const memories = await this.memoryStore.getUserMemories(userId, 'history');
    const memory = memories.find(
      (candidate) =>
        candidate.memoryId === cleanEventId &&
        candidate.sourceSessionId?.startsWith(TASTE_FEEDBACK_MEMORY_PREFIX)
    );
    const event = memory ? decodeTasteFeedback(memory) : null;
    if (!memory || !event) throw new TasteFeedbackNotFoundError();
    if (event.reversedAt) return event;

    const updated: Omit<TasteFeedbackEvent, 'eventId'> = {
      schema: event.schema,
      artifactType: event.artifactType,
      artifactId: event.artifactId,
      direction: event.direction,
      receipt: event.receipt,
      createdAt: event.createdAt,
      reversedAt: new Date().toISOString(),
    };
    const content = encodeTasteFeedback(updated);
    await this.memoryStore.updateMemory(userId, memory.memoryId, {
      category: 'history',
      content,
    });
    return { ...updated, eventId: memory.memoryId };
  }

  async deleteProfile(userId: string): Promise<number> {
    const memories = await this.memoryStore.getUserMemories(userId, 'preference');
    const tasteMemories = memories.filter((memory) =>
      memory.sourceSessionId?.startsWith(TASTE_MEMORY_PREFIX)
    );
    await Promise.all(tasteMemories.map((memory) => this.memoryStore.deleteMemory(userId, memory.memoryId)));
    return tasteMemories.length;
  }

  private async saveSnapshot(userId: string, snapshot: TasteSourceSnapshot): Promise<void> {
    const sourceSessionId = sourceMemoryId(snapshot.sourceKey);
    const content = encodeSnapshot(snapshot);
    if (charLength(content) > 2000) {
      throw new TasteValidationError('Taste profile exceeded the durable memory size limit');
    }

    const memories = await this.memoryStore.getUserMemories(userId, 'preference');
    const tasteMemories = memories.filter((memory) =>
      memory.sourceSessionId?.startsWith(TASTE_MEMORY_PREFIX)
    );
    const existing = tasteMemories.find((memory) => memory.sourceSessionId === sourceSessionId);
    if (existing) {
      await this.memoryStore.updateMemory(userId, existing.memoryId, {
        category: 'preference',
        content,
      });
      return;
    }

    if (tasteMemories.length >= MAX_TASTE_SOURCES) {
      throw new TasteValidationError(
        `Taste supports at most ${MAX_TASTE_SOURCES} durable sources; replace or delete an existing source first`
      );
    }

    await this.memoryStore.addMemory(userId, 'preference', content, sourceSessionId);
  }
}

export const tasteProfileService = new TasteProfileService();

export const _tasteInternalsForTests = {
  normalizeItems,
  snapshotFor,
  decodeSnapshot,
  aggregateSnapshots,
  assertNoSensitiveKeys,
  deriveTasteDials,
  buildTasteApplication,
  defaultTasteSettings,
  decodeTasteSettings,
  normalizeTasteSettingsPatch,
  tasteProfileRevision,
  tasteSettingsRevision,
  decodeTasteFeedback,
  applyTasteFeedback,
};
