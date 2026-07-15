/**
 * Tests for search_user_guide surfacing the canonical documentation site
 * (docs.agentweb.pro) so Emma can return correct integration deep links
 * (e.g. https://docs.agentweb.pro/integrations/hubspot).
 *
 * Regression test for ENG-314: Emma could not access the docs.agentweb.pro
 * knowledge source when answering client integration questions.
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
});

describe('search_user_guide tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('appends the documentation site reference to the Notion guide content', async () => {
    (getUserGuideContent as jest.Mock).mockResolvedValue('PORTAL ONBOARDING GUIDE BODY');

    const result = await emmaToolRegistry.execute(TOOL, {});

    expect(result.success).toBe(true);
    expect(result.content).toContain('PORTAL ONBOARDING GUIDE BODY');
    expect(result.content).toContain('https://docs.agentweb.pro/integrations/hubspot');
  });

  it('still surfaces the documentation site when the Notion guide is empty', async () => {
    (getUserGuideContent as jest.Mock).mockResolvedValue('   ');

    const result = await emmaToolRegistry.execute(TOOL, {});

    expect(result.success).toBe(true);
    expect(result.content).toContain('https://docs.agentweb.pro/integrations/hubspot');
  });

  it('returns a failure message when fetching the user guide throws', async () => {
    (getUserGuideContent as jest.Mock).mockRejectedValue(new Error('notion down'));

    const result = await emmaToolRegistry.execute(TOOL, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('notion down');
  });
});
