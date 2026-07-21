import { emmaToolRegistry } from './registry';
import { getUserGuideContent } from '../services/notionService';
import { buildDocumentationReference } from './documentationSite';

// Available to all users — Emma uses this to answer user guide questions
emmaToolRegistry.register({
  name: 'search_user_guide',
  definition: {
    name: 'search_user_guide',
    description: 'Fetch the full user guide content plus the canonical documentation site reference (docs.agentweb.pro). Use this tool when users ask about how to use the portal, need help with features, or ask how to set up/use an integration (e.g. HubSpot). Returns the user guide text and the documentation deep links (e.g. https://docs.agentweb.pro/integrations/hubspot).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async () => {
    // The documentation site is a knowledge source Emma always consults so it
    // can return correct integration deep links even when the Notion portal
    // guide has no dedicated walkthrough for the integration in question. Build
    // it up front so the static reference still surfaces if Notion fails.
    const docsReference = buildDocumentationReference();
    try {
      const content = await getUserGuideContent();
      if (!content || content.trim().length === 0) {
        return { success: true, content: docsReference.trim() };
      }
      return { success: true, content: `${content}\n${docsReference}` };
    } catch (error: any) {
      // Notion is an unrelated dependency; if it fails, still return the
      // canonical docs reference so integration deep links remain available.
      return {
        success: true,
        content: `The portal user guide was temporarily unavailable (${error.message}).\n${docsReference}`.trim(),
      };
    }
  },
});

// NOTE: the admin-only `manage_user_guide` Notion write tool was removed in
// ENG-163 (legacy docs corpus deleted; docs consolidated on Mintlify). Emma no
// longer writes to the Notion user-guide page.
