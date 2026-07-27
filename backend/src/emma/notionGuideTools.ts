import { emmaToolRegistry } from './registry';
import { getUserGuideContent } from '../services/notionService';
import { buildDocumentationReference, searchDocumentation } from './documentationSite';

// Available to all users — Emma uses this to answer user guide questions
emmaToolRegistry.register({
  name: 'search_user_guide',
  definition: {
    name: 'search_user_guide',
    description: 'Search the canonical AgentWeb Mintlify documentation at docs.agentweb.pro. Use this before asking a user to complete a manual product or integration step. Pass the exact feature, blockage, or setup step as the query. Returns one bounded relevant excerpt and its canonical source link.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact AgentWeb feature, integration, or blocked setup step to look up.',
          maxLength: 500,
        },
      },
      required: [],
    },
  },
  execute: async (args: { query?: string }) => {
    const query = args?.query?.trim() || '';
    const docsReference = buildDocumentationReference();

    if (!query) {
      return { success: true, content: docsReference.trim(), results: [] };
    }

    try {
      const result = await searchDocumentation(query);
      return { success: true, ...result };
    } catch (mintlifyError: any) {
      // The old Notion guide remains a degraded fallback, never the canonical
      // source. This keeps help available during a docs-site outage without
      // making every healthy request depend on Notion.
      try {
        const legacyContent = await getUserGuideContent();
        const fallbackBody = legacyContent?.trim() || 'The legacy portal guide is empty.';
        return {
          success: true,
          content: [
            `Mintlify documentation search is temporarily unavailable (${mintlifyError.message}).`,
            'Legacy fallback from the portal guide:',
            fallbackBody,
            docsReference,
          ].join('\n\n'),
          results: [],
        };
      } catch (notionError: any) {
        return {
          success: true,
          content: [
            `Mintlify documentation search is temporarily unavailable (${mintlifyError.message}).`,
            `Legacy fallback is also unavailable (${notionError.message}).`,
            docsReference,
          ].join('\n\n'),
          results: [],
        };
      }
    }
  },
});

// NOTE: the admin-only `manage_user_guide` Notion write tool was removed in
// ENG-163 (legacy docs corpus deleted; docs consolidated on Mintlify). Emma no
// longer writes to the Notion user-guide page.
