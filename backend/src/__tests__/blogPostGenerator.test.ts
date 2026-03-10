import { BlogPostGenerator, BlogDraftRequest } from '../services/blogPostGenerator';

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('BlogPostGenerator', () => {
  let generator: BlogPostGenerator;

  beforeEach(() => {
    jest.clearAllMocks();
    generator = new BlogPostGenerator({
      baseUrl: 'http://localhost:3001',
      jwtSecret: 'test-secret',
      systemUserId: 'admin-user-id',
    });
  });

  // FAIL test 1: Missing required fields
  it('should throw validation error when feature_name is missing', async () => {
    const request: Partial<BlogDraftRequest> = {
      pr_title: 'feat: Add new widget',
      pr_url: 'https://github.com/test/repo/pull/1',
    };

    await expect(generator.generate(request as BlogDraftRequest)).rejects.toThrow('feature_name is required');
  });

  it('should throw validation error when pr_title is missing', async () => {
    const request: Partial<BlogDraftRequest> = {
      feature_name: 'New Widget',
      pr_url: 'https://github.com/test/repo/pull/1',
    };

    await expect(generator.generate(request as BlogDraftRequest)).rejects.toThrow('pr_title is required');
  });

  // FAIL test 2: Emma session creation failure
  it('should throw when Emma session creation fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Service unavailable' }),
    });

    const request: BlogDraftRequest = {
      feature_name: 'LinkedIn Preview',
      pr_title: 'feat: LinkedIn post preview with truncation',
      pr_url: 'https://github.com/test/repo/pull/241',
      steps: ['Open LinkedIn Preview page', 'Paste post content', 'See truncation preview'],
    };

    await expect(generator.generate(request)).rejects.toThrow('session creation');
  });

  // FAIL test 3: Emma message send failure
  it('should throw when Emma message send fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'session-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'LLM timeout' }),
    });

    const request: BlogDraftRequest = {
      feature_name: 'Client Health',
      pr_title: 'feat: Client health dashboard',
      pr_url: 'https://github.com/test/repo/pull/242',
    };

    await expect(generator.generate(request)).rejects.toThrow('message send');
  });

  // SUCCESS test 4: Full generation succeeds
  it('should return blog draft on successful generation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'session-456' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        response: '# How to Use LinkedIn Post Preview\n\nThe new LinkedIn Preview feature lets you...',
      }),
    });

    const request: BlogDraftRequest = {
      feature_name: 'LinkedIn Post Preview',
      pr_title: 'feat: LinkedIn post preview with truncation simulation',
      pr_url: 'https://github.com/AgentWebPro/agentweb-customer-portal/pull/241',
      steps: ['Navigate to LinkedIn Preview', 'Paste your post content', 'See how it will appear'],
      screenshot_urls: ['https://s3.amazonaws.com/screenshots/linkedin-1.png'],
      notion_task_url: 'https://notion.so/task-123',
    };

    const result = await generator.generate(request);

    expect(result.sessionId).toBe('session-456');
    expect(result.draft).toContain('LinkedIn Post Preview');
    expect(result.status).toBe('completed');
  });

  // SUCCESS test 5: Screenshot URLs included in prompt
  it('should include screenshot URLs in the prompt sent to Emma', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'session-789' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: 'Draft content here' }),
    });

    const screenshotUrls = [
      'https://s3.amazonaws.com/screenshots/step1.png',
      'https://s3.amazonaws.com/screenshots/step2.png',
    ];

    await generator.generate({
      feature_name: 'Password Change',
      pr_title: 'feat: Add password change to Settings',
      pr_url: 'https://github.com/test/repo/pull/258',
      screenshot_urls: screenshotUrls,
    });

    // Check the message body sent to Emma
    const [, messageOpts] = mockFetch.mock.calls[1];
    const body = JSON.parse(messageOpts.body);
    expect(body.userMessage).toContain('step1.png');
    expect(body.userMessage).toContain('step2.png');
  });

  // SUCCESS test 6: Steps are formatted in the prompt
  it('should format steps as numbered list in the prompt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 's1' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: 'Draft' }),
    });

    await generator.generate({
      feature_name: 'Email Templates',
      pr_title: 'feat: Email template system',
      pr_url: 'https://github.com/test/repo/pull/100',
      steps: ['Click Create Template', 'Enter HTML content', 'Click Preview', 'Click Save'],
    });

    const [, messageOpts] = mockFetch.mock.calls[1];
    const body = JSON.parse(messageOpts.body);
    expect(body.userMessage).toContain('1. Click Create Template');
    expect(body.userMessage).toContain('2. Enter HTML content');
    expect(body.userMessage).toContain('3. Click Preview');
    expect(body.userMessage).toContain('4. Click Save');
  });
});
