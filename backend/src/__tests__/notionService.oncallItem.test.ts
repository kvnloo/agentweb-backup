// Unit tests for createOncallItem in notionService

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock secretsManager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    apiToken: 'test-notion-token',
    userGuidePageId: 'test-page-id',
  })),
}));

import { createOncallItem, getSprintTasksDatabaseId } from '../services/notionService';

describe('notionService - createOncallItem', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should suppress alert in non-production environments', async () => {
    process.env.NODE_ENV = 'development';
    const result = await createOncallItem({ title: 'Test', description: 'Desc' });
    expect(result).toEqual({ pageId: '', notionUrl: '' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should create a Notion page with correct properties and return URL', async () => {
    const mockPageId = '12345678-1234-1234-1234-123456789abc';
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        id: mockPageId,
        object: 'page',
      }),
      status: 200,
    });

    const result = await createOncallItem({
      title: 'Test oncall issue',
      description: 'Something broke',
    });

    expect(result.pageId).toBe(mockPageId);
    expect(result.notionUrl).toBe(`https://notion.so/${mockPageId.replace(/-/g, '')}`);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.parent).toEqual({ type: 'data_source_id', data_source_id: expect.any(String) });
    expect(body.properties['Name'].title[0].text.content).toBe('Test oncall issue');
    expect(body.properties['Status'].status.name).toBe('To-do');
    expect(body.properties['Tags'].multi_select).toEqual([{ name: 'Oncall' }]);
    expect(body.properties['Sprint'].rich_text[0].text.content).toBe('Backlog');
    expect(body.properties['Move to Current Sprint'].checkbox).toBe(true);
    expect(body.children[0].paragraph.rich_text[0].text.content).toBe('Something broke');
  });

  it('should include additional tags merged with Oncall', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ id: 'page-id', object: 'page' }),
      status: 200,
    });

    await createOncallItem({
      title: 'Customer issue',
      description: 'Bug report',
      additionalTags: ['Customer Reported'],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties['Tags'].multi_select).toEqual([
      { name: 'Oncall' },
      { name: 'Customer Reported' },
    ]);
  });

  it('should include context as bulleted list items', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ id: 'page-id', object: 'page' }),
      status: 200,
    });

    await createOncallItem({
      title: 'Test',
      description: 'Desc',
      context: {
        'Session ID': 'sess-123',
        'Error': 'timeout',
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // description paragraph + heading + 2 bulleted items = 4 children
    expect(body.children).toHaveLength(4);
    expect(body.children[1].type).toBe('heading_3');
    expect(body.children[1].heading_3.rich_text[0].text.content).toBe('Context');
    expect(body.children[2].type).toBe('bulleted_list_item');
    expect(body.children[2].bulleted_list_item.rich_text[0].text.content).toBe('Session ID: sess-123');
    expect(body.children[3].bulleted_list_item.rich_text[0].text.content).toBe('Error: timeout');
  });

  it('should truncate long context values to 500 chars', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ id: 'page-id', object: 'page' }),
      status: 200,
    });

    const longValue = 'x'.repeat(600);
    await createOncallItem({
      title: 'Test',
      description: 'Desc',
      context: { 'Long': longValue },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const bulletText = body.children[2].bulleted_list_item.rich_text[0].text.content;
    expect(bulletText.length).toBeLessThan(520); // "Long: " + 500 + "..."
    expect(bulletText).toContain('...');
  });

  it('should throw when Notion API returns an error', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        object: 'error',
        message: 'Unauthorized',
      }),
      status: 401,
    });

    await expect(createOncallItem({
      title: 'Test',
      description: 'Desc',
    })).rejects.toThrow('Notion API error: Unauthorized');
  });
});

describe('notionService - getSprintTasksDatabaseId', () => {
  it('should return default database ID when not in credentials', async () => {
    const dbId = await getSprintTasksDatabaseId();
    expect(dbId).toBe('2bf09247-c951-812a-bd0a-000bd4c05bbf');
  });
});
