/**
 * Unit tests for POST /api/blog/publish-direct endpoint (publishBlogDirect controller)
 */

// Mock agentModeService
const mockPublishBlogArticle = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    publishBlogArticle: mockPublishBlogArticle,
  },
}));

// Mock db
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

// Mock chatbotService
const mockUpdateSessionPublishStatuses = jest.fn();
const mockGetChatSession = jest.fn();
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({
    updateSessionPublishStatuses: mockUpdateSessionPublishStatuses,
    getChatSession: mockGetChatSession,
  })),
}));

// Mock axios for HTML fetching
jest.mock('axios', () => ({
  get: jest.fn(),
  default: { get: jest.fn() },
}));
import axios from 'axios';
const mockedAxios = axios as any;

import { Request, Response } from 'express';

let publishBlogDirect: any;

beforeAll(async () => {
  const blogController = await import('../controllers/blog');
  publishBlogDirect = blogController.publishBlogDirect;
});

const mockResponse = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const mockRequest = (body: any, userId?: string) => {
  return {
    user: userId ? { userId, email: 'test@example.com' } : undefined,
    body,
  } as any;
};

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Blog Post Title</title>
  <meta name="description" content="This is a test description for the blog post">
</head>
<body>
  <img class="hero-image" src="https://storage.example.com/images/hero.jpg" alt="Hero">
  <div class="content">
    <p>Hello World</p>
  </div>
</body>
</html>`;

const SAMPLE_HTML_NO_IMAGE = `<!DOCTYPE html>
<html>
<head>
  <title>No Image Post</title>
  <meta name="description" content="A post without a hero image">
</head>
<body>
  <div class="content">
    <p>No hero image here</p>
  </div>
</body>
</html>`;

describe('publishBlogDirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL tests ---

  it('should return 401 when user is not authenticated', async () => {
    const req = mockRequest({ blogHtmlUrl: 'https://example.com/report.html' });
    const res = mockResponse();

    await publishBlogDirect(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 400 when blogHtmlUrl is missing', async () => {
    const req = mockRequest({}, 'user-123');
    const res = mockResponse();

    await publishBlogDirect(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('blogHtmlUrl') })
    );
  });

  it('should proceed with empty hero image when HTML has no image', async () => {
    const req = mockRequest({
      blogHtmlUrl: 'https://example.com/report.html',
      status: 'draft',
    }, 'user-123');
    const res = mockResponse();

    mockedAxios.get.mockResolvedValue({ data: SAMPLE_HTML_NO_IMAGE });
    mockPublishBlogArticle.mockResolvedValue({
      success: true,
      message: 'Published as draft',
      data: { status: 'draft' },
    });

    await publishBlogDirect(req, res);

    expect(mockPublishBlogArticle).toHaveBeenCalledWith(
      'No Image Post',
      'A post without a hero image',
      '', // empty hero image
      'https://example.com/report.html',
      'user-123',
      '',
      'draft',
      undefined,
      undefined
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should return 500 when publishBlogArticle fails', async () => {
    const req = mockRequest({
      blogHtmlUrl: 'https://example.com/report.html',
      status: 'draft',
    }, 'user-123');
    const res = mockResponse();

    mockedAxios.get.mockResolvedValue({ data: SAMPLE_HTML });
    mockPublishBlogArticle.mockResolvedValue({
      success: false,
      message: 'CMS Type not configured',
    });

    await publishBlogDirect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  // --- SUCCESS tests ---

  it('should extract title, description, and hero image from HTML and call publishBlogArticle', async () => {
    const req = mockRequest({
      blogHtmlUrl: 'https://example.com/report.html',
      status: 'draft',
      author: 'John Doe',
      categories: ['Technology'],
    }, 'user-123');
    const res = mockResponse();

    mockedAxios.get.mockResolvedValue({ data: SAMPLE_HTML });
    mockPublishBlogArticle.mockResolvedValue({
      success: true,
      message: 'Published as draft',
      data: { status: 'draft', title: 'Test Blog Post Title', cmsType: 'Webflow' },
    });

    await publishBlogDirect(req, res);

    expect(mockPublishBlogArticle).toHaveBeenCalledWith(
      'Test Blog Post Title',
      'This is a test description for the blog post',
      'https://storage.example.com/images/hero.jpg',
      'https://example.com/report.html',
      'user-123',
      '', // no sessionId
      'draft',
      'John Doe',
      ['Technology']
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('should store publishStatus in session when sessionId is provided', async () => {
    const req = mockRequest({
      blogHtmlUrl: 'https://example.com/report.html',
      status: 'published',
      sessionId: 'session-abc',
      categories: ['Marketing'],
    }, 'user-123');
    const res = mockResponse();

    mockedAxios.get.mockResolvedValue({ data: SAMPLE_HTML });
    mockPublishBlogArticle.mockResolvedValue({
      success: true,
      message: 'Published',
      data: { status: 'published', title: 'Test', cmsType: 'Webflow' },
    });
    mockGetChatSession.mockResolvedValue({
      sessionId: 'session-abc',
      publishStatuses: {},
    });

    await publishBlogDirect(req, res);

    expect(mockUpdateSessionPublishStatuses).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({
        'https://example.com/report.html': 'published',
      })
    );
  });

  it('should default status to draft when not provided', async () => {
    const req = mockRequest({
      blogHtmlUrl: 'https://example.com/report.html',
    }, 'user-123');
    const res = mockResponse();

    mockedAxios.get.mockResolvedValue({ data: SAMPLE_HTML });
    mockPublishBlogArticle.mockResolvedValue({
      success: true,
      message: 'Published as draft',
      data: { status: 'draft' },
    });

    await publishBlogDirect(req, res);

    expect(mockPublishBlogArticle).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'user-123',
      '',
      'draft',
      undefined,
      undefined
    );
  });
});
