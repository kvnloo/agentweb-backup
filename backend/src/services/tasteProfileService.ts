import { createHash } from 'crypto';
import { accountMemoryDb } from './db';
import { twitterService } from './twitterService';

export const TASTE_MEMORY_PREFIX = 'taste-profile:v1:';
export const TASTE_PROFILE_SCHEMA = 'taste.profile.v1';
export const MAX_TASTE_ITEMS = 250;
export const MAX_TASTE_TEXT_CHARS = 2000;
export const MAX_TASTE_TITLE_CHARS = 300;
export const MAX_TASTE_URL_CHARS = 2048;
export const MAX_TASTE_TAGS = 20;
export const MAX_TASTE_TAG_CHARS = 64;
export const MAX_TASTE_COLLECTION_ID_CHARS = 64;

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
  digest: string;
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
  ): Promise<MemoryRecord>;
  updateMemory(
    userId: string,
    memoryId: string,
    updates: { content?: string; category?: string }
  ): Promise<MemoryRecord | undefined>;
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
  const digest = createHash('sha256')
    .update(items.map(stableItemKey).sort().join('\n'))
    .digest('hex')
    .slice(0, 24);

  return {
    schema: TASTE_PROFILE_SCHEMA,
    source,
    sourceKey,
    itemCount: items.length,
    digest,
    topDomains: countTop(domains, MAX_PROFILE_DOMAINS).map((entry) => entry.value),
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

  const updatedAt = snapshots
    .map((snapshot) => snapshot.generatedAt)
    .sort()
    .at(-1) || null;

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

function sourceMemoryId(sourceKey: string): string {
  return `${TASTE_MEMORY_PREFIX}${sourceKey}`;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class TasteProfileService {
  constructor(
    private readonly xReader: TasteXBookmarkReader = twitterService,
    private readonly memoryStore: TasteMemoryStore = accountMemoryDb as TasteMemoryStore
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
    const memories = await this.memoryStore.getUserMemories(userId, 'preference', 100);
    const snapshots = memories
      .filter((memory) => memory.sourceSessionId?.startsWith(TASTE_MEMORY_PREFIX))
      .map(decodeSnapshot)
      .filter((snapshot): snapshot is TasteSourceSnapshot => Boolean(snapshot));

    return aggregateSnapshots(snapshots);
  }

  async deleteProfile(userId: string): Promise<number> {
    const memories = await this.memoryStore.getUserMemories(userId, 'preference', 100);
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

    const memories = await this.memoryStore.getUserMemories(userId, 'preference', 100);
    const existing = memories.find((memory) => memory.sourceSessionId === sourceSessionId);
    if (existing) {
      await this.memoryStore.updateMemory(userId, existing.memoryId, {
        category: 'preference',
        content,
      });
      return;
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
};
