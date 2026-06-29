import { _deps, processActionItems } from '../services/meetingIntakeService';

describe('meetingIntakeService routing', () => {
  const originals = { ..._deps };

  beforeEach(() => {
    _deps.createNotionTask = jest.fn(async () => ({ id: 'notion-task-1' }));
    _deps.createClickUpTask = jest.fn(async () => ({ id: 'clickup-task-1' }));
    _deps.createFeaturebasePost = jest.fn(async () => ({
      postId: 'feature-post-1',
      postUrl: 'https://feedback.agentweb.pro/p/feature-post-1',
      linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-456'],
    }));
    _deps.searchExistingTasks = jest.fn(async () => []);
  });

  afterAll(() => {
    Object.assign(_deps, originals);
  });

  it('routes feature requests to Featurebase instead of Notion', async () => {
    const result = await processActionItems({
      meetingTitle: 'Customer Sync',
      timestamp: '2026-06-29T16:40:00.000Z',
      participants: ['customer@example.com', 'harsha@agentweb.pro'],
      actionItems: ['Can we add dark mode to the dashboard?'],
    });

    expect(_deps.createFeaturebasePost).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Can we add dark mode to the dashboard?',
        kind: 'feature',
        priority: 'Low',
        tags: ['Customer Request', 'feature-request', 'priority:Low'],
        reporter: {
          userId: 'meeting-intake',
          name: 'Meeting intake',
        },
        context: expect.objectContaining({
          'Meeting Title': 'Customer Sync',
          'Meeting Timestamp': '2026-06-29T16:40:00.000Z',
          Participants: 'customer@example.com, harsha@agentweb.pro',
        }),
      }),
    );
    expect(_deps.createNotionTask).not.toHaveBeenCalled();
    expect(result.created).toEqual([
      {
        description: 'Can we add dark mode to the dashboard?',
        type: 'feature-request',
        destination: 'featurebase',
        externalId: 'feature-post-1',
      },
    ]);
  });

  it('keeps engineering action items on the existing Notion task route', async () => {
    const result = await processActionItems({
      meetingTitle: 'Engineering Sync',
      timestamp: '2026-06-29T16:40:00.000Z',
      participants: [],
      actionItems: ['Fix the webhook retry bug'],
    });

    expect(_deps.createNotionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Fix the webhook retry bug',
        tags: ['Improvement'],
      }),
    );
    expect(_deps.createFeaturebasePost).not.toHaveBeenCalled();
    expect(result.created[0]).toEqual(
      expect.objectContaining({
        type: 'eng-task',
        destination: 'notion',
        externalId: 'notion-task-1',
      }),
    );
  });
});
