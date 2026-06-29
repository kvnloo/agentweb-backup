/**
 * Tests for meetingIntakeService — Meeting action item classification,
 * deduplication, and routing to Notion / ClickUp / Featurebase.
 */

import {
  classifyActionItem,
  computeSimilarity,
  MeetingData,
  ClassifiedItem,
  processActionItems,
  RoutingResult,
  _deps,
} from '../meetingIntakeService';

// ---------------------------------------------------------------------------
// 1. Classification tests
// ---------------------------------------------------------------------------
describe('classifyActionItem', () => {
  // --- eng-task matches ---
  it('classifies code-related items as eng-task', () => {
    const result = classifyActionItem('Fix the login bug on the signup page');
    expect(result.type).toBe('eng-task');
  });

  it('classifies deploy/infra items as eng-task', () => {
    const result = classifyActionItem('Deploy the new API endpoint to staging');
    expect(result.type).toBe('eng-task');
  });

  it('classifies PR/test items as eng-task', () => {
    const result = classifyActionItem('Write unit tests for the user service');
    expect(result.type).toBe('eng-task');
  });

  it('classifies database/migration items as eng-task', () => {
    const result = classifyActionItem('Run the database migration for the new schema');
    expect(result.type).toBe('eng-task');
  });

  it('classifies backend/frontend items as eng-task', () => {
    const result = classifyActionItem('Update the backend validation logic');
    expect(result.type).toBe('eng-task');
  });

  // --- delivery-task matches ---
  it('classifies email items as delivery-task', () => {
    const result = classifyActionItem('Send the weekly report email to the client');
    expect(result.type).toBe('delivery-task');
  });

  it('classifies scheduling items as delivery-task', () => {
    const result = classifyActionItem('Schedule a follow-up meeting with the design team');
    expect(result.type).toBe('delivery-task');
  });

  it('classifies content updates as delivery-task', () => {
    const result = classifyActionItem('Update content on the marketing page and post it');
    expect(result.type).toBe('delivery-task');
  });

  it('classifies reach-out items as delivery-task', () => {
    const result = classifyActionItem('Reach out to the vendor about pricing');
    expect(result.type).toBe('delivery-task');
  });

  // --- feature-request matches ---
  it('classifies "would be nice" as feature-request', () => {
    const result = classifyActionItem('It would be nice to have a dark mode');
    expect(result.type).toBe('feature-request');
  });

  it('classifies "can we add" as feature-request', () => {
    const result = classifyActionItem('Can we add a CSV export feature?');
    expect(result.type).toBe('feature-request');
  });

  it('classifies integration requests as feature-request', () => {
    const result = classifyActionItem('We should integrate with Slack for notifications');
    expect(result.type).toBe('feature-request');
  });

  it('classifies "wish we had" as feature-request', () => {
    const result = classifyActionItem('I wish we had better filtering options');
    expect(result.type).toBe('feature-request');
  });

  // --- ignore matches ---
  it('classifies pleasantries as ignore', () => {
    const result = classifyActionItem('Great meeting everyone, thanks!');
    expect(result.type).toBe('ignore');
  });

  it('classifies scheduling confirmations as ignore', () => {
    const result = classifyActionItem("Sounds good, let's talk next week");
    expect(result.type).toBe('ignore');
  });

  it('classifies vague statements as ignore', () => {
    const result = classifyActionItem('Yeah that makes sense');
    expect(result.type).toBe('ignore');
  });

  // --- priority assignment ---
  it('assigns High priority to items with urgent keywords', () => {
    const result = classifyActionItem('Fix the critical production bug ASAP');
    expect(result.priority).toBe('High');
  });

  it('assigns Medium priority by default for eng-tasks', () => {
    const result = classifyActionItem('Add a new API endpoint for user preferences');
    expect(result.priority).toBe('Medium');
  });

  it('assigns Low priority for nice-to-have items', () => {
    const result = classifyActionItem('It would be nice to have a dark mode someday');
    expect(result.priority).toBe('Low');
  });
});

// ---------------------------------------------------------------------------
// 2. Similarity / deduplication tests
// ---------------------------------------------------------------------------
describe('computeSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(computeSimilarity('fix login bug', 'fix login bug')).toBe(1.0);
  });

  it('returns high similarity for near-identical strings', () => {
    const score = computeSimilarity('fix the login bug', 'fix login bug');
    expect(score).toBeGreaterThan(0.7);
  });

  it('returns low similarity for unrelated strings', () => {
    const score = computeSimilarity('deploy api endpoint', 'send email to client');
    expect(score).toBeLessThan(0.3);
  });

  it('is case-insensitive', () => {
    expect(computeSimilarity('Fix Login Bug', 'fix login bug')).toBe(1.0);
  });

  it('handles empty strings', () => {
    expect(computeSimilarity('', '')).toBe(1.0);
    expect(computeSimilarity('something', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. processActionItems integration tests (with mocked externals)
// ---------------------------------------------------------------------------
describe('processActionItems', () => {
  const mockCreateNotionTask = jest.fn().mockResolvedValue({ id: 'notion-123' });
  const mockCreateClickUpTask = jest.fn().mockResolvedValue({ id: 'clickup-456' });
  const mockCreateFeaturebasePost = jest.fn().mockResolvedValue({
    postId: 'featurebase-789',
    postUrl: 'https://feedback.agentweb.pro/p/featurebase-789',
    linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-789'],
  });
  const mockSearchExistingTasks = jest.fn().mockResolvedValue([]);

  // Save originals so we can restore
  let originalDeps: typeof _deps;

  beforeAll(() => {
    originalDeps = { ..._deps };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchExistingTasks.mockResolvedValue([]);

    // Inject mocks into _deps
    _deps.createNotionTask = mockCreateNotionTask;
    _deps.createClickUpTask = mockCreateClickUpTask;
    _deps.createFeaturebasePost = mockCreateFeaturebasePost;
    _deps.searchExistingTasks = mockSearchExistingTasks;
  });

  afterAll(() => {
    // Restore originals
    _deps.createNotionTask = originalDeps.createNotionTask;
    _deps.createClickUpTask = originalDeps.createClickUpTask;
    _deps.createFeaturebasePost = originalDeps.createFeaturebasePost;
    _deps.searchExistingTasks = originalDeps.searchExistingTasks;
  });

  const baseMeetingData: MeetingData = {
    meetingTitle: 'Sprint Planning',
    timestamp: '2026-03-16T10:00:00Z',
    participants: ['harsha@agentweb.pro', 'ruiw@agentweb.pro'],
    actionItems: [],
  };

  it('creates Notion task for eng-task items', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Fix the login bug on the API'],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(1);
    expect(result.created[0].type).toBe('eng-task');
    expect(result.created[0].destination).toBe('notion');
    expect(mockCreateNotionTask).toHaveBeenCalledTimes(1);
  });

  it('creates ClickUp task for delivery-task items', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Send the weekly report email to the client'],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(1);
    expect(result.created[0].type).toBe('delivery-task');
    expect(result.created[0].destination).toBe('clickup');
    expect(mockCreateClickUpTask).toHaveBeenCalledTimes(1);
  });

  it('creates Featurebase post with Customer Request tag for feature-requests', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Can we add a CSV export feature?'],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(1);
    expect(result.created[0].type).toBe('feature-request');
    expect(result.created[0].destination).toBe('featurebase');
    expect(result.created[0].externalId).toBe('featurebase-789');
    expect(mockCreateNotionTask).not.toHaveBeenCalled();
    expect(mockCreateFeaturebasePost).toHaveBeenCalledTimes(1);
    // Verify it was called with Customer Request tag
    const callArgs = mockCreateFeaturebasePost.mock.calls[0][0];
    expect(callArgs.tags).toContain('Customer Request');
    expect(callArgs.kind).toBe('feature');
    expect(callArgs.context).toEqual(expect.objectContaining({
      'Meeting Title': 'Sprint Planning',
      'Meeting Timestamp': '2026-03-16T10:00:00Z',
    }));
  });

  it('skips ignored items and creates no tasks', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Thanks everyone, great meeting!'],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toBe('ignored');
    expect(mockCreateNotionTask).not.toHaveBeenCalled();
    expect(mockCreateClickUpTask).not.toHaveBeenCalled();
    expect(mockCreateFeaturebasePost).not.toHaveBeenCalled();
  });

  it('handles empty action items gracefully', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: [],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(0);
    expect(result.skipped.length).toBe(0);
    expect(mockCreateNotionTask).not.toHaveBeenCalled();
    expect(mockCreateClickUpTask).not.toHaveBeenCalled();
    expect(mockCreateFeaturebasePost).not.toHaveBeenCalled();
  });

  it('deduplicates items that already exist in Notion', async () => {
    mockSearchExistingTasks.mockResolvedValue([
      { title: 'Fix the login bug on the API' },
    ]);

    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Fix the login bug on the API'],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toBe('duplicate');
    expect(mockCreateNotionTask).not.toHaveBeenCalled();
  });

  it('processes multiple action items of different types', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: [
        'Fix the database migration script',
        'Send the proposal to the client',
        'Can we add dark mode support?',
        'Sounds good, see you next week',
      ],
    };

    const result = await processActionItems(meeting);

    expect(result.created.length).toBe(3);
    expect(result.skipped.length).toBe(1);

    const types = result.created.map((c) => c.type);
    expect(types).toContain('eng-task');
    expect(types).toContain('delivery-task');
    expect(types).toContain('feature-request');
    expect(mockCreateFeaturebasePost).toHaveBeenCalledTimes(1);
  });

  it('includes meeting metadata in created tasks', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Fix the API endpoint validation'],
    };

    await processActionItems(meeting);

    const callArgs = mockCreateNotionTask.mock.calls[0][0];
    expect(callArgs.meetingTitle).toBe('Sprint Planning');
    expect(callArgs.meetingTimestamp).toBe('2026-03-16T10:00:00Z');
  });

  it('returns summary with meeting metadata', async () => {
    const meeting: MeetingData = {
      ...baseMeetingData,
      actionItems: ['Fix the bug', 'Send the email to client'],
    };

    const result = await processActionItems(meeting);

    expect(result.meetingTitle).toBe('Sprint Planning');
    expect(result.processedAt).toBeDefined();
  });
});
