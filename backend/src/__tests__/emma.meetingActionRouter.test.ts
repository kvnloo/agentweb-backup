/**
 * Tests for the fathom_route_action_items Emma tool.
 *
 * This tool takes Fathom meeting data (title, participants, action items)
 * and routes each action item to Notion or ClickUp via meetingIntakeService.
 */

// Mock axios before any imports
jest.mock('axios');

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  updateAccountConfig: jest.fn(),
}));

// Mock integrations config
jest.mock('../config/integrations', () => ({
  getFathomConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/fathom/callback',
    scopes: ['public_api'],
    authorizationUrl: 'https://fathom.ai/oauth/authorize',
    tokenUrl: 'https://api.fathom.ai/external/v1/oauth2/token',
  }),
}));

// Mock the meetingIntakeService
jest.mock('../services/meetingIntakeService', () => ({
  processActionItems: jest.fn(),
  classifyActionItem: jest.requireActual('../services/meetingIntakeService').classifyActionItem,
  computeSimilarity: jest.requireActual('../services/meetingIntakeService').computeSimilarity,
  _deps: {
    createNotionTask: jest.fn(),
    createClickUpTask: jest.fn(),
    searchExistingTasks: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';

// Import the tool to register it
import '../emma/meetingActionRouter';

import { processActionItems } from '../services/meetingIntakeService';

const mockedProcessActionItems = processActionItems as jest.MockedFunction<typeof processActionItems>;

// Helper to execute a registered tool
const executeTool = async (name: string, args: any, context: any = {}) => {
  const tool = emmaToolRegistry.getTool(name);
  if (!tool) throw new Error(`Tool "${name}" not found in registry`);
  return tool.execute(args, context);
};

describe('fathom_route_action_items', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in emmaToolRegistry', () => {
    expect(emmaToolRegistry.getTool('fathom_route_action_items')).toBeDefined();
  });

  it('routes action items from a meeting and returns routing result', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Sprint Planning',
      processedAt: '2026-03-16T10:00:00Z',
      created: [
        { description: 'Fix the login bug', type: 'eng-task', destination: 'notion', externalId: 'notion-123' },
        { description: 'Send proposal to client', type: 'delivery-task', destination: 'clickup', externalId: 'clickup-456' },
      ],
      skipped: [
        { description: 'Thanks everyone', reason: 'ignored' },
      ],
    });

    const result = await executeTool(
      'fathom_route_action_items',
      {
        meeting_title: 'Sprint Planning',
        participants: ['harsha@agentweb.pro', 'ruiw@agentweb.pro'],
        action_items: [
          'Fix the login bug',
          'Send proposal to client',
          'Thanks everyone',
        ],
      },
      { userId: 'user-1' }
    );

    expect(result.success).toBe(true);
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.created[0].type).toBe('eng-task');
    expect(result.created[0].destination).toBe('notion');
    expect(result.created[1].type).toBe('delivery-task');
    expect(result.created[1].destination).toBe('clickup');

    // Verify processActionItems was called with correct shape
    expect(mockedProcessActionItems).toHaveBeenCalledTimes(1);
    expect(mockedProcessActionItems).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingTitle: 'Sprint Planning',
        participants: ['harsha@agentweb.pro', 'ruiw@agentweb.pro'],
        actionItems: ['Fix the login bug', 'Send proposal to client', 'Thanks everyone'],
      })
    );
  });

  it('returns error when userId is missing', async () => {
    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Test',
      action_items: ['Fix bug'],
    }, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('Authentication required');
  });

  it('returns error when action_items is missing or empty', async () => {
    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Test',
    }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('action_items');
  });

  it('returns error when meeting_title is missing', async () => {
    const result = await executeTool('fathom_route_action_items', {
      action_items: ['Fix bug'],
    }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('meeting_title');
  });

  it('handles processActionItems failure gracefully', async () => {
    mockedProcessActionItems.mockRejectedValue(new Error('Notion API down'));

    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Sprint Planning',
      action_items: ['Fix the bug'],
    }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to route action items');
  });

  it('handles empty action_items array gracefully', async () => {
    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Quick Sync',
      action_items: [],
    }, { userId: 'user-1' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('action_items');
  });

  it('defaults participants to empty array when not provided', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Quick Sync',
      processedAt: '2026-03-16T10:00:00Z',
      created: [
        { description: 'Fix the API endpoint', type: 'eng-task', destination: 'notion', externalId: 'notion-789' },
      ],
      skipped: [],
    });

    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Quick Sync',
      action_items: ['Fix the API endpoint'],
    }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(mockedProcessActionItems).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: [],
      })
    );
  });

  it('includes summary statistics in the response', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Design Review',
      processedAt: '2026-03-16T10:00:00Z',
      created: [
        { description: 'Update the UI', type: 'eng-task', destination: 'notion', externalId: 'n-1' },
        { description: 'Email client update', type: 'delivery-task', destination: 'clickup', externalId: 'c-1' },
        { description: 'Add dark mode', type: 'feature-request', destination: 'featurebase', externalId: 'fb-2' },
      ],
      skipped: [
        { description: 'Sounds good', reason: 'ignored' },
        { description: 'Fix the bug again', reason: 'duplicate' },
      ],
    });

    const result = await executeTool('fathom_route_action_items', {
      meeting_title: 'Design Review',
      action_items: [
        'Update the UI',
        'Email client update',
        'Add dark mode',
        'Sounds good',
        'Fix the bug again',
      ],
    }, { userId: 'user-1' });

    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBe(5);
    expect(result.summary.created).toBe(3);
    expect(result.summary.skipped).toBe(2);
  });
});
