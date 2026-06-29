/**
 * Emma tool: fathom_route_action_items
 *
 * Takes meeting data (title, participants, action items) and routes each
 * action item to the correct system via meetingIntakeService:
 *   - eng-task       -> Notion sprint board
 *   - delivery-task  -> ClickUp CEO board
 *   - feature-request -> Featurebase feature board
 *   - ignore         -> skipped
 */

import { emmaToolRegistry } from './registry';
import { processActionItems, MeetingData } from '../services/meetingIntakeService';

emmaToolRegistry.register({
  name: 'fathom_route_action_items',
  definition: {
    name: 'fathom_route_action_items',
    description:
      'Route meeting action items to the correct project management systems. ' +
      'Takes a meeting title, participants, and action items (from Fathom or any source). ' +
      'Each action item is classified as: eng-task (-> Notion), delivery-task (-> ClickUp), ' +
      'feature-request (-> Featurebase), or ignored. ' +
      'Deduplicates against existing tasks before creating new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_title: {
          type: 'string',
          description: 'Title of the meeting (required)',
        },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of participant names or emails (optional)',
        },
        action_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of action item strings to classify and route (required, non-empty)',
        },
        timestamp: {
          type: 'string',
          description: 'ISO timestamp of the meeting (defaults to now)',
        },
      },
      required: ['meeting_title', 'action_items'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'Authentication required: no user context.' };
    }

    const { meeting_title, participants, action_items, timestamp } = args;

    if (!meeting_title || typeof meeting_title !== 'string' || meeting_title.trim() === '') {
      return { success: false, message: 'meeting_title is required and must be a non-empty string.' };
    }

    if (!action_items || !Array.isArray(action_items) || action_items.length === 0) {
      return { success: false, message: 'action_items is required and must be a non-empty array of strings.' };
    }

    const meetingData: MeetingData = {
      meetingTitle: meeting_title.trim(),
      timestamp: timestamp || new Date().toISOString(),
      participants: Array.isArray(participants) ? participants : [],
      actionItems: action_items.filter((item: any) => typeof item === 'string' && item.trim() !== ''),
    };

    try {
      const result = await processActionItems(meetingData);

      return {
        success: true,
        meetingTitle: result.meetingTitle,
        processedAt: result.processedAt,
        created: result.created,
        skipped: result.skipped,
        summary: {
          total: result.created.length + result.skipped.length,
          created: result.created.length,
          skipped: result.skipped.length,
        },
      };
    } catch (error: any) {
      console.error('[fathom_route_action_items] Error:', error?.message);
      return {
        success: false,
        message: `Failed to route action items: ${error?.message || 'Unknown error'}`,
      };
    }
  },
});
