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
import { getFathomAccessToken } from '../services/fathomTokenService';
import { userDb } from '../services/db';

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';

/**
 * Safety cap on Fathom pagination — 20 pages × 10/page = 200 recordings.
 * Mirrors FATHOM_MAX_PAGES in prospectMeetingService so the agent-mode tool
 * and the metrics service have the same coverage.
 */
const FATHOM_MAX_PAGES = 20;

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
      // Fathom's /meetings endpoint paginates with `next_cursor` (default page
      // size of 10). Follow the cursor until exhausted (or the safety cap is
      // hit) so that "who did we meet last week" style queries don't silently
      // lose every meeting after the first page.
      const meetings: any[] = [];
      let cursor: string | undefined;
      let pageCount = 0;

      do {
        const params = new URLSearchParams({
          include_action_items: 'true',
        });
        if (args.created_after) params.set('created_after', args.created_after);
        if (args.created_before) params.set('created_before', args.created_before);
        if (cursor) params.set('cursor', cursor);

        const url = `${FATHOM_API_BASE}/meetings?${params.toString()}`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });

        // Fathom API returns { items: [...], limit, next_cursor }
        const rawData = response.data as any;
        const meetingsArray = Array.isArray(rawData) ? rawData
          : Array.isArray(rawData?.items) ? rawData.items
          : Array.isArray(rawData?.calls) ? rawData.calls
          : Array.isArray(rawData?.meetings) ? rawData.meetings
          : [];

        for (const m of meetingsArray) {
          meetings.push({
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
          });
        }

        cursor = typeof rawData?.next_cursor === 'string' && rawData.next_cursor.length > 0
          ? rawData.next_cursor
          : undefined;
        pageCount++;
      } while (cursor && pageCount < FATHOM_MAX_PAGES);

      if (cursor) {
        console.warn(
          `[fathom_get_meetings] Hit FATHOM_MAX_PAGES (${FATHOM_MAX_PAGES}) — ` +
          `returning ${meetings.length} meetings, more may exist. Narrow the date range to see them.`,
        );
      }

      return {
        success: true,
        count: meetings.length,
        meetings,
      };
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401 || status === 403) {
        return {
          success: false,
          message:
            'Your Fathom access token is invalid or has been revoked. ' +
            'Please reconnect your Fathom account in Settings → Connected Accounts.',
        };
      }
      console.error('[fathom_get_meetings] API error:', error?.message);
      return {
        success: false,
        message: `Failed to fetch meetings from Fathom: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});

// ── fathom_get_onboarding_context ────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'fathom_get_onboarding_context',
  definition: {
    name: 'fathom_get_onboarding_context',
    description:
      'Get reviewed Fathom-derived onboarding context for the current account. ' +
      'Use this to personalize onboarding, first-win recommendations, and customer-support guidance from sales/prospect calls.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    const user = await userDb.getUserById(userId);
    const ingestions = Array.isArray((user as any)?.fathomOnboardingIngestions)
      ? (user as any).fathomOnboardingIngestions
      : [];
    const reviewed = ingestions.filter((item: any) => item.status === 'reviewed');

    return {
      success: true,
      count: reviewed.length,
      contexts: reviewed.map((item: any) => ({
        recordingId: item.recordingId,
        recordingUrl: item.recordingUrl,
        extractionState: item.extractionState,
        reviewedAt: item.updatedAt,
        matchReason: item.matchReason,
        context: item.context,
      })),
    };
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
      if (status === 401 || status === 403) {
        return {
          success: false,
          message:
            'Your Fathom access token is invalid or has been revoked. ' +
            'Please reconnect your Fathom account in Settings → Connected Accounts.',
        };
      }
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
