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
  getUserGuideBlocks: jest.fn(),
  updateBlock: jest.fn(),
  appendBlocks: jest.fn(),
  deleteBlock: jest.fn(),
  getBlock: jest.fn(),
  getNotionCredentials: jest.fn(),
}));

import { getUserGuideContent } from '../services/notionService';
import '../emma/notionGuideTools';
import { emmaToolRegistry } from '../emma/registry';
import {
  DOCS_SITE_BASE_URL,
  integrationDocUrl,
  buildDocumentationReference,
} from '../emma/documentationSite';

const TOOL = 'search_user_guide';

describe('documentationSite helpers', () => {
  it('exposes the canonical docs base URL', () => {
    expect(DOCS_SITE_BASE_URL).toBe('https://docs.agentweb.pro');
  });

  it('builds the correct HubSpot integration deep link', () => {
    expect(integrationDocUrl('hubspot')).toBe('https://docs.agentweb.pro/integrations/hubspot');
  });

  it('reference text lists the docs site and integration deep links', () => {
    const ref = buildDocumentationReference();
    expect(ref).toContain('https://docs.agentweb.pro');
    expect(ref).toContain('https://docs.agentweb.pro/integrations/hubspot');
  });

  it('reference text does not instruct fabricating links for unlisted integrations', () => {
    const ref = buildDocumentationReference();
    // Must not carry a placeholder pattern Emma could fill in for an
    // unsupported integration (e.g. Salesforce) — that produced dead links.
    expect(ref).not.toContain('<integration-slug>');
    expect(ref.toLowerCase()).toContain('do not invent');
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
