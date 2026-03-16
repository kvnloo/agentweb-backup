/**
 * Fathom meeting tools for Emma.
 *
 * Two tools:
 *   - fathom_get_meetings  — list recent meetings with summaries & action items
 *   - fathom_get_transcript — get the full transcript for a specific recording
 *
 * Both require the user to have a Fathom account connected (platform = 'fathom')
 * with an API key stored in config.access_token.
 */

import axios from 'axios';
import { emmaToolRegistry } from './registry';
import { getAccountsByUserId } from '../services/connectedAccountsDb';

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

/**
 * Retrieve the Fathom API key from the user's connected accounts.
 * Returns null if no Fathom account is connected.
 */
async function getFathomApiKey(userId: string): Promise<string | null> {
  const accounts = await getAccountsByUserId(userId);
  const fathomAccount = accounts.find(acc => acc.platform === 'fathom');
  if (!fathomAccount) return null;
  return fathomAccount.config.access_token || null;
}

// ── fathom_get_meetings ──────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'fathom_get_meetings',
  definition: {
    name: 'fathom_get_meetings',
    description:
      'List recent meetings recorded by Fathom with summaries and action items. ' +
      'Requires a connected Fathom account (Settings → Connected Accounts). ' +
      'Returns title, date, participants, summary snippet, action items count, and recording_id ' +
      '(use recording_id with fathom_get_transcript to get the full transcript).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of meetings to return (default 10, max 50)',
        },
        created_after: {
          type: 'string',
          description: 'Only return meetings created after this ISO date (e.g. "2026-03-01T00:00:00Z")',
        },
        created_before: {
          type: 'string',
          description: 'Only return meetings created before this ISO date (e.g. "2026-03-15T00:00:00Z")',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    const apiKey = await getFathomApiKey(userId);
    if (!apiKey) {
      return {
        success: false,
        message:
          'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.',
      };
    }

    try {
      const limit = Math.min(Math.max(args.limit || 10, 1), 50);
      const params = new URLSearchParams({
        include_summary: 'true',
        include_action_items: 'true',
        limit: String(limit),
      });
      if (args.created_after) params.set('created_after', args.created_after);
      if (args.created_before) params.set('created_before', args.created_before);

      const url = `${FATHOM_API_BASE}/meetings?${params.toString()}`;
      const response = await axios.get(url, {
        headers: { 'X-Api-Key': apiKey },
      });

      const meetings = (response.data || []).map((m: any) => ({
        id: m.id,
        recording_id: m.recording_id,
        title: m.title,
        created_at: m.created_at,
        duration_seconds: m.duration_seconds,
        participants: m.participants || [],
        summary: m.summary || null,
        action_items_count: Array.isArray(m.action_items) ? m.action_items.length : 0,
        action_items: (m.action_items || []).map((ai: any) => ai.text || ai),
      }));

      return {
        success: true,
        count: meetings.length,
        meetings,
      };
    } catch (error: any) {
      console.error('[fathom_get_meetings] API error:', error?.message);
      return {
        success: false,
        message: `Failed to fetch meetings from Fathom: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});

// ── fathom_get_transcript ────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'fathom_get_transcript',
  definition: {
    name: 'fathom_get_transcript',
    description:
      'Get the full transcript for a specific Fathom meeting recording. ' +
      'Use the recording_id from fathom_get_meetings results. ' +
      'Returns speaker-attributed transcript turns.',
    inputSchema: {
      type: 'object',
      properties: {
        recording_id: {
          type: 'number',
          description: 'The recording ID from the meetings list (required)',
        },
      },
      required: ['recording_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    if (!args.recording_id && args.recording_id !== 0) {
      return { success: false, message: 'recording_id is required. Use fathom_get_meetings to find recording IDs.' };
    }

    const apiKey = await getFathomApiKey(userId);
    if (!apiKey) {
      return {
        success: false,
        message:
          'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.',
      };
    }

    try {
      const url = `${FATHOM_API_BASE}/recordings/${args.recording_id}/transcript`;
      const response = await axios.get(url, {
        headers: { 'X-Api-Key': apiKey },
      });

      const data = response.data;
      const turns = (data?.transcript || []).map((t: any) => ({
        speaker: t.speaker,
        text: t.text,
        start_time: t.start_time,
      }));

      return {
        success: true,
        recording_id: args.recording_id,
        transcript: turns,
      };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        return {
          success: false,
          message: `Recording ${args.recording_id} not found. Use fathom_get_meetings to list available recordings.`,
        };
      }
      console.error('[fathom_get_transcript] API error:', error?.message);
      return {
        success: false,
        message: `Failed to fetch transcript from Fathom: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});
