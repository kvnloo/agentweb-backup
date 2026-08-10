/**
 * Tests for search_user_guide searching the canonical Mintlify corpus so Emma
 * can answer a blocked product/setup question with one relevant excerpt and
 * canonical source link.
 *
 * Regression coverage for ENG-450. The old behavior returned an entire legacy
 * Notion guide plus a short list of static integration links.
 */

jest.mock('../services/notionService', () => ({
  getUserGuideContent: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { getUserGuideContent } from '../services/notionService';
import '../emma/notionGuideTools';
import { emmaToolRegistry } from '../emma/registry';
import {
  DOCS_SITE_BASE_URL,
  buildDocumentationReference,
  integrationsFromPages,
  resetDocumentationCache,
  type DocumentationPage,
} from '../emma/documentationSite';

const TOOL = 'search_user_guide';

/** A corpus shaped like the real llms-full.txt, including integrations no
 *  hand-maintained list in this repo has ever known about. */
const CORPUS = [
  '# Meta (Facebook + Instagram)',
  'Source: https://docs.agentweb.pro/integrations/meta',
  'Open Connected Accounts, choose Meta, and complete OAuth.',
  '# Google Ads',
  'Source: https://docs.agentweb.pro/integrations/google-ads',
  'Link your Google Ads manager account.',
  '# Outlook / Microsoft 365',
  'Source: https://docs.agentweb.pro/integrations/outlook',
  'Authorize Outlook to send from your mailbox.',
  '# What is Emma',
  'Source: https://docs.agentweb.pro/what-is-emma',
  'Emma is the AI marketing agent.',
].join('\n');

const mockCorpusFetch = () =>
  (global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => CORPUS }) as jest.Mock);

describe('documentationSite helpers', () => {
  it('exposes the canonical docs base URL', () => {
    expect(DOCS_SITE_BASE_URL).toBe('https://docs.agentweb.pro');
  });

  it('reference text lists the docs site and the integration deep links it was given', () => {
    const ref = buildDocumentationReference([
      { slug: 'hubspot', name: 'HubSpot', url: 'https://docs.agentweb.pro/integrations/hubspot' },
    ]);
    expect(ref).toContain('https://docs.agentweb.pro');
    expect(ref).toContain('https://docs.agentweb.pro/integrations/hubspot');
  });

  it('reference text does not instruct fabricating links for unlisted integrations', () => {
    const ref = buildDocumentationReference([
      { slug: 'hubspot', name: 'HubSpot', url: 'https://docs.agentweb.pro/integrations/hubspot' },
    ]);
    // Must not carry a placeholder pattern Emma could fill in for an
    // unsupported integration (e.g. Salesforce) — that produced dead links.
    expect(ref).not.toContain('<integration-slug>');
    expect(ref.toLowerCase()).toContain('do not invent');
  });
});

/**
 * ENG-1029. `search_user_guide` searched Mintlify (ENG-450) but a second,
 * hand-maintained copy of the integration list shipped beside it. It drifted:
 * it advertised `/integrations/slack`, which 404s and is not a connected
 * account at all, and it omitted Google Ads, Outlook and X — while instructing
 * Emma to tell clients that anything unlisted "isn't a supported integration
 * yet". The published corpus is the only source of truth for this list.
 */
describe('integration guides are derived from the published corpus (ENG-1029)', () => {
  const pages: DocumentationPage[] = [
    { title: 'Meta (Facebook + Instagram)', url: 'https://docs.agentweb.pro/integrations/meta', content: 'x' },
    { title: 'Google Ads', url: 'https://docs.agentweb.pro/integrations/google-ads', content: 'x' },
    { title: 'Outlook / Microsoft 365', url: 'https://docs.agentweb.pro/integrations/outlook', content: 'x' },
    { title: 'What is Emma', url: 'https://docs.agentweb.pro/what-is-emma', content: 'x' },
    { title: 'Authentication', url: 'https://docs.agentweb.pro/api-reference/authentication', content: 'x' },
  ];

  it('derives every published integration guide, including ones no literal in this repo lists', () => {
    expect(integrationsFromPages(pages).map((i) => i.slug)).toEqual([
      'google-ads',
      'meta',
      'outlook',
    ]);
  });

  it('carries the corpus page title and canonical URL, not a hand-written name', () => {
    const outlook = integrationsFromPages(pages).find((i) => i.slug === 'outlook');
    expect(outlook).toEqual({
      slug: 'outlook',
      name: 'Outlook / Microsoft 365',
      url: 'https://docs.agentweb.pro/integrations/outlook',
    });
  });

  it('ignores pages that are not integration guides', () => {
    const slugs = integrationsFromPages(pages).map((i) => i.slug);
    expect(slugs).not.toContain('what-is-emma');
    expect(slugs).not.toContain('authentication');
  });

  it('emits no link for an integration the corpus does not publish', () => {
    const ref = buildDocumentationReference(integrationsFromPages(pages));
    expect(ref).toContain('https://docs.agentweb.pro/integrations/google-ads');
    expect(ref).not.toContain('integrations/slack');
  });

  it('keeps no hardcoded integration path in the source, so the list cannot drift again', () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'emma', 'documentationSite.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    // A concrete slug after /integrations/ means a second source of truth is
    // back. A parsing pattern (`/integrations/([a-z0-9-]+)`) does not match.
    expect(source).not.toMatch(/\/integrations\/[a-z0-9][a-z0-9-]+/);
  });
});

describe('search_user_guide with no query (ENG-1029)', () => {
  beforeEach(() => {
    resetDocumentationCache();
    mockCorpusFetch();
  });

  it('returns the integration links the docs site actually publishes', async () => {
    const result = await emmaToolRegistry.execute(TOOL, {});

    expect(result.success).toBe(true);
    expect(result.content).toContain('https://docs.agentweb.pro/integrations/google-ads');
    expect(result.content).toContain('https://docs.agentweb.pro/integrations/outlook');
    expect(result.results).toEqual([]);
  });

  it('never advertises an integration that is absent from the corpus', async () => {
    const result = await emmaToolRegistry.execute(TOOL, {});

    expect(result.content).not.toContain('integrations/slack');
  });
});

describe('search_user_guide during a docs outage (ENG-1029)', () => {
  beforeEach(() => {
    resetDocumentationCache();
    global.fetch = jest.fn().mockRejectedValue(new Error('mintlify down')) as jest.Mock;
    (getUserGuideContent as jest.Mock).mockResolvedValue('LEGACY PORTAL GUIDE BODY');
  });

  it('emits no integration deep links rather than a possibly stale list', async () => {
    const result = await emmaToolRegistry.execute(TOOL, { query: 'connect anything' });

    expect(result.content).not.toContain('/integrations/');
    expect(result.content).toContain(DOCS_SITE_BASE_URL);
  });

  it('does not let an unreachable index read as "this integration is unsupported"', async () => {
    const result = await emmaToolRegistry.execute(TOOL, { query: 'connect anything' });

    expect(result.content.toLowerCase()).not.toContain("isn't a supported integration");
    expect(result.content.toLowerCase()).toContain('unavailable');
  });
});

describe('search_user_guide tool', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('falls back to the legacy Notion guide when Mintlify is unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('mintlify down')) as jest.Mock;
    (getUserGuideContent as jest.Mock).mockResolvedValue('LEGACY PORTAL GUIDE BODY');

    const result = await emmaToolRegistry.execute(TOOL, { query: 'connect Meta' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('LEGACY PORTAL GUIDE BODY');
    expect(result.content).toMatch(/legacy fallback/i);
    expect(result.content).toContain(DOCS_SITE_BASE_URL);
  });

  it('searches the Mintlify corpus and returns only the relevant canonical page', async () => {
    const oversizedMetaDetails = `Meta detail for campaign setup. `.repeat(900);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        '# Google Ads',
        'Source: https://docs.agentweb.pro/integrations/google-ads',
        'Compare this Google account with a Meta ads account.',
        '# Meta (Facebook + Instagram)',
        'Source: https://docs.agentweb.pro/integrations/meta',
        'Open Connected Accounts, choose Meta, and complete OAuth.',
        oversizedMetaDetails,
        '# Connect Google Drive',
        'Source: https://docs.agentweb.pro/integrations/google-drive',
        'Choose Google Drive and select folders to index.',
      ].join('\n'),
    }) as jest.Mock;

    const result = await emmaToolRegistry.execute(TOOL, { query: 'How do I connect Meta ads?' });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://docs.agentweb.pro/llms-full.txt',
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(result.content).toContain('Meta (Facebook + Instagram)');
    expect(result.content).toContain('complete OAuth');
    expect(result.content).toContain('Meta detail for campaign setup');
    expect(result.content).not.toContain('select folders to index');
    expect(result.results).toEqual([
      expect.objectContaining({
        title: 'Meta (Facebook + Instagram)',
        url: 'https://docs.agentweb.pro/integrations/meta',
        recommended: true,
      }),
    ]);
  });

  it('keeps the Mintlify result bounded instead of returning the full corpus', async () => {
    const result = await emmaToolRegistry.execute(TOOL, { query: 'Meta campaign setup' });

    expect(result.content.length).toBeLessThanOrEqual(12_000);
    expect(result.results).toHaveLength(1);
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });

  it('accepts a query so Emma can retrieve the exact blocked setup step', () => {
    const tool = emmaToolRegistry.getTool(TOOL);

    expect(tool?.definition.inputSchema.properties.query).toEqual(
      expect.objectContaining({ type: 'string' })
    );
  });
});

describe('manage_user_guide removal (ENG-163)', () => {
  it('does not register the legacy manage_user_guide Notion write tool', () => {
    expect(emmaToolRegistry.getTool('manage_user_guide')).toBeUndefined();
  });

  it('still registers the read-only search_user_guide tool', () => {
    expect(emmaToolRegistry.getTool('search_user_guide')).toBeDefined();
  });
});
