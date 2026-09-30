import { emmaToolRegistry } from './registry';
import {
  TASTE_SURFACES,
  TasteValidationError,
  tasteProfileService,
} from '../services/tasteProfileService';

emmaToolRegistry.register({
  name: 'get_taste_profile',
  definition: {
    name: 'get_taste_profile',
    description:
      'Read the authenticated user\'s aggregate Taste Profile. Use this before creative/design work when personal preference would help. ' +
      'Taste is a preference layer, not a source of truth: explicit user instructions, brand guidelines, audience, accessibility, compliance, ' +
      'platform constraints, and performance evidence always outrank it. Raw source bookmarks/collections are not returned.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Taste Profile requires an authenticated user');
    return await tasteProfileService.getProfile(userId);
  },
  readOnly: true,
  requiresUserAccount: true,
});

emmaToolRegistry.register({
  name: 'preview_taste_application',
  definition: {
    name: 'preview_taste_application',
    description:
      'Preview exactly how the user\'s Taste Profile should influence one Emma surface. ' +
      'Returns the derived Taste Skill dials, confidence, surface-specific guardrails, and a compact prompt context. ' +
      'Use this for landing pages, images, video, brand proposals, social/editorial work, ad creative, research presentation, or reply curation. ' +
      'Email/CRM/analytics default to Taste off. This tool never changes the profile.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          enum: [...TASTE_SURFACES],
          description: 'Emma surface being worked on.',
        },
        intensity: {
          type: 'string',
          enum: ['off', 'subtle', 'strong'],
          description:
            'Optional per-task override. Omit to use the surface default. Strong is appropriate for explicitly creative asks; off disables Taste for this task.',
        },
      },
      required: ['surface'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Taste application preview requires an authenticated user');
    return await tasteProfileService.getApplication(userId, args.surface, args.intensity);
  },
  readOnly: true,
  requiresUserAccount: true,
});


emmaToolRegistry.register({
  name: 'get_taste_settings',
  definition: {
    name: 'get_taste_settings',
    description:
      'Read the authenticated user\'s persistent per-surface Taste defaults. ' +
      'These are defaults only; a task-local off/subtle/strong override does not mutate them.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Taste settings require an authenticated user');
    return await tasteProfileService.getSettings(userId);
  },
  readOnly: true,
  requiresUserAccount: true,
});

emmaToolRegistry.register({
  name: 'update_taste_settings',
  definition: {
    name: 'update_taste_settings',
    description:
      'Persist one or more per-surface Taste defaults for the authenticated user. ' +
      'ONLY call when the user explicitly asks to change their ongoing Taste behavior (for example, "always use strong Taste for social" or "never use Taste for email"). ' +
      'Do not call this for a one-off request; use preview_taste_application with a task-local intensity instead.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaces: {
          type: 'object',
          description: 'Map of Emma surface to off, subtle, or strong.',
          additionalProperties: {
            type: 'string',
            enum: ['off', 'subtle', 'strong'],
          },
        },
      },
      required: ['surfaces'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Taste settings require an authenticated user');
    return await tasteProfileService.updateSettings(userId, args.surfaces);
  },
  requiresUserAccount: true,
});

emmaToolRegistry.register({
  name: 'refresh_taste_from_x',
  definition: {
    name: 'refresh_taste_from_x',
    description:
      'Explicitly refresh the authenticated user\'s Taste Profile from bookmarks in one already-connected X account. ' +
      'ONLY call when the user clearly asks to import, sync, refresh, or learn from their X bookmarks. ' +
      'The tool reuses AgentWeb\'s connected-account OAuth path; never ask the user to paste X tokens or credentials. ' +
      'Raw bookmark text is processed ephemerally and only aggregate preference signals are retained.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Existing AgentWeb connected X account id. Use list_connected_accounts first if needed.',
        },
      },
      required: ['account_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Taste refresh requires an authenticated user');
    try {
      return await tasteProfileService.importXBookmarks(userId, args.account_id);
    } catch (error) {
      if (error instanceof TasteValidationError) throw error;
      throw error;
    }
  },
  requiresUserAccount: true,
});
