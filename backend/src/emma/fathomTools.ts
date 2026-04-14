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
import { getAccountsByUserId, updateAccountConfig } from '../services/connectedAccountsDb';
import { getFathomConfig } from '../config/integrations';

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

/**
 * Retrieve the Fathom access token from the user's connected accounts.
 * For OAuth accounts, automatically refreshes the token if expired.
 * Returns null if no Fathom account is connected.
 */
async function getFathomAccessToken(userId: string): Promise<string | null> {
  const accounts = await getAccountsByUserId(userId);
  const fathomAccount = accounts.find(acc => acc.platform === 'fathom');
  if (!fathomAccount) return null;

  const config = fathomAccount.config as any;

  // Check if token needs refresh (OAuth accounts only)
  if (config.refresh_token && config.token_expires_at && Date.now() > config.token_expires_at - 60000) {
    try {
      const fathomConfig = await getFathomConfig();
      const response = await axios.post(fathomConfig.tokenUrl, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refresh_token,
        client_id: fathomConfig.clientId,
        client_secret: fathomConfig.clientSecret,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const { access_token, refresh_token, expires_in } = response.data as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      await updateAccountConfig(userId, 'fathom', fathomAccount.account_id, {
        access_token,
        ...(refresh_token && { refresh_token }),
        token_expires_at: Date.now() + (expires_in * 1000),
      });

      return access_token;
    } catch (err: any) {
      console.error('[Fathom] Token refresh failed:', err?.message);
      // Fall through to use existing token
    }
  }

  return config.access_token || null;
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

    const accessToken = await getFathomAccessToken(userId);
    if (!accessToken) {
      return {
        success: false,
        message:
          'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.',
      };
    }

    try {
      const params = new URLSearchParams({
        include_action_items: 'true',
      });
      if (args.created_after) params.set('created_after', args.created_after);
      if (args.created_before) params.set('created_before', args.created_before);

      const url = `${FATHOM_API_BASE}/meetings?${params.toString()}`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      console.log('[fathom_get_meetings] Response type:', typeof response.data, 'isArray:', Array.isArray(response.data), 'keys:', Object.keys(response.data || {}), 'sample:', JSON.stringify(response.data).substring(0, 300));

      // Fathom API returns { items: [...], limit, next_cursor }
      const rawData = response.data as any;
      const meetingsArray = Array.isArray(rawData) ? rawData
        : Array.isArray(rawData?.items) ? rawData.items
        : Array.isArray(rawData?.calls) ? rawData.calls
        : Array.isArray(rawData?.meetings) ? rawData.meetings
        : [];

      const meetings = meetingsArray.map((m: any) => ({
        recording_id: m.recording_id,
        title: m.title || m.meeting_title,
        url: m.url || m.share_url,
        created_at: m.created_at,
        scheduled_start_time: m.scheduled_start_time,
        recording_start_time: m.recording_start_time,
        recording_end_time: m.recording_end_time,
        recorded_by: m.recorded_by?.name || m.recorded_by?.email || null,
        participants: m.calendar_invitees?.map((i: any) => i.name || i.email) || [],
        summary: m.default_summary?.short_hand_bullet || m.default_summary || null,
        action_items_count: Array.isArray(m.action_items) ? m.action_items.length : 0,
        action_items: (m.action_items || []).map((ai: any) => ai.text || ai.title || ai),
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

    const accessToken = await getFathomAccessToken(userId);
    if (!accessToken) {
      return {
        success: false,
        message:
          'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.',
      };
    }

    try {
      const url = `${FATHOM_API_BASE}/recordings/${args.recording_id}/transcript`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      const data = response.data as any;
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
