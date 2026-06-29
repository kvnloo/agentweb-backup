import {
  buildFeaturebasePostContent,
  createFeaturebasePost,
} from '../services/featurebaseService';

describe('featurebaseService', () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FEATUREBASE_API_KEY: 'fb-test-key',
      FEATUREBASE_BUG_BOARD_ID: 'bug-board',
      FEATUREBASE_FEATURE_BOARD_ID: 'feature-board',
      FEATUREBASE_BUG_IN_REVIEW_STATUS_ID: 'review-status',
    };
    (global as any).fetch = fetchMock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        id: 'post-1',
        postUrl: 'https://feedback.agentweb.pro/p/post-1',
        integrations: {
          linear: [{ issueUrl: 'https://linear.app/agentweb/issue/ENG-123' }],
        },
      }),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates bug posts on the bug board and pushes to Linear', async () => {
    const result = await createFeaturebasePost({
      title: 'Sidebar flickers',
      description: 'Steps\nExpected\nActual',
      kind: 'bug',
      priority: 'High',
      tags: ['Customer Reported', 'bug', 'priority:High'],
      attachmentUrls: ['https://s3.example.com/a.png'],
      reporter: { userId: 'user-1', email: 'user@example.com', name: 'User One' },
      context: { Priority: 'High', 'Page URL': 'https://app.example.com' },
    });

    expect(result).toEqual({
      postId: 'post-1',
      postUrl: 'https://feedback.agentweb.pro/p/post-1',
      linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-123'],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://do.featurebase.app/v2/posts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fb-test-key',
          'Content-Type': 'application/json',
          'Featurebase-Version': '2026-01-01.nova',
        }),
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.boardId).toBe('bug-board');
    expect(body.statusId).toBe('review-status');
    expect(body.integrations).toEqual({ linear: true });
    expect(body.author).toEqual({ userId: 'user-1', email: 'user@example.com', name: 'User One' });
    expect(body.tags).toEqual(['Customer Reported', 'bug', 'priority:High']);
    expect(body.content).toContain('Steps<br>Expected<br>Actual');
    expect(body.content).toContain('https://s3.example.com/a.png');
  });

  it('creates feature posts on the feature board', async () => {
    await createFeaturebasePost({
      title: 'Add CSV export',
      description: 'Customer wants exports',
      kind: 'feature',
      reporter: { userId: 'user-2', email: 'pm@example.com' },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.boardId).toBe('feature-board');
    expect(body.statusId).toBeUndefined();
  });

  it('throws a readable error when Featurebase rejects the request', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: { message: 'boardId is invalid' } }),
    });

    await expect(createFeaturebasePost({
      title: 'Bad',
      description: 'Request',
      kind: 'bug',
      reporter: { userId: 'user-1' },
    })).rejects.toThrow('Featurebase API error (400): boardId is invalid');
  });

  it('escapes HTML in descriptions and context', () => {
    const html = buildFeaturebasePostContent({
      description: '<script>alert("x")</script>',
      context: { 'User Email': 'evil@example.com<script>' },
      attachmentUrls: [],
    });

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('evil@example.com&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
