// Unit tests for repair_blog_article HTML restructuring in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock axios
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn()
  }
}));

// Use shared AWS SDK mock (src/__mocks__/aws-sdk.ts)
jest.mock('aws-sdk');

// Mock database
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

describe('AgentModeService - repairBlogArticle HTML restructuring', () => {
  let agentModeService: AgentModeService;
  let mockAxiosGet: jest.Mock;

  // Helper to get the uploaded HTML from S3 putObject calls
  const getUploadedHtml = (): string => {
    const AWS = require('aws-sdk');
    const s3Constructor = AWS.default.S3 as jest.Mock;
    // Get the most recent S3 instance created
    const lastInstance = s3Constructor.mock.results[s3Constructor.mock.results.length - 1].value;
    const putObjectMock = lastInstance.putObject as jest.Mock;
    return putObjectMock.mock.calls[0][0].Body;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    process.env.NODE_ENV = 'development';
    process.env.AWS_S3_BUCKET = 'test-bucket';
    process.env.AWS_REGION = 'us-west-2';

    const axiosModule = require('axios');
    mockAxiosGet = axiosModule.default.get;
  });

  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-123';
  const mockArticleUrl = 'https://test-bucket.s3.us-west-2.amazonaws.com/users/test-user-123/files/blog.html';

  it('should restructure HTML without <div class="content"> by wrapping body content', async () => {
    const htmlWithoutContentDiv = `<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <h1>My Article Title</h1>
  <img src="https://test-bucket.s3.us-west-2.amazonaws.com/hero.png" alt="Hero">
  <p>Article body content</p>
  <p>More content here</p>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: htmlWithoutContentDiv });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);
    expect(result.structureRepaired).toBe(true);
    expect(result.message).toContain('HTML restructured');

    // Verify the uploaded HTML has div.content wrapper
    const uploadedHtml = getUploadedHtml();
    expect(uploadedHtml).toContain('<div class="content">');
    // h1 should be outside div.content
    const contentDivIndex = uploadedHtml.indexOf('<div class="content">');
    const h1Index = uploadedHtml.indexOf('<h1>');
    expect(h1Index).toBeLessThan(contentDivIndex);
    // Body content should be inside div.content
    expect(uploadedHtml).toContain('Article body content');
    expect(uploadedHtml).toContain('More content here');
  });

  it('should extract hero image and place it outside <div class="content">', async () => {
    const htmlWithHero = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <h1>Title</h1>
  <img src="https://test-bucket.s3.us-west-2.amazonaws.com/hero.png" alt="Hero">
  <p>Content after hero</p>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: htmlWithHero });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);

    const uploadedHtml = getUploadedHtml();
    // Hero image should be outside div.content
    const contentDivIndex = uploadedHtml.indexOf('<div class="content">');
    const heroImgIndex = uploadedHtml.indexOf('hero.png');
    expect(heroImgIndex).toBeLessThan(contentDivIndex);
    // Content after hero should be inside div.content
    expect(uploadedHtml.indexOf('Content after hero')).toBeGreaterThan(contentDivIndex);
  });

  it('should handle complex header with meta-bar, author-block, and hero image', async () => {
    const complexHeaderHtml = `<!DOCTYPE html>
<html>
<head><title>Test</title>
<style>.stat-card { background: #f0f0f0; }</style>
</head>
<body>
  <div class="meta-bar">Published March 2, 2026 <span class="reading-time">9 min read</span></div>
  <h1>What Tool Ensures Peer Feedback Stays Confidential?</h1>
  <div class="author-block">By Renata Bell, Co-Founder</div>
  <img class="hero-image" src="https://test-bucket.s3.us-west-2.amazonaws.com/hero.png" alt="Hero">
  <p>Direct answer paragraph</p>
  <div class="tldr-box"><div class="tldr-label">TL;DR</div><ul><li>Point one</li></ul></div>
  <h2>First Section</h2>
  <p>Section content</p>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: complexHeaderHtml });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);
    expect(result.structureRepaired).toBe(true);

    const uploadedHtml = getUploadedHtml();
    const contentDivIndex = uploadedHtml.indexOf('<div class="content">');
    expect(contentDivIndex).toBeGreaterThan(-1);

    // Header elements should be OUTSIDE div.content
    expect(uploadedHtml.indexOf('meta-bar')).toBeLessThan(contentDivIndex);
    expect(uploadedHtml.indexOf('<h1>')).toBeLessThan(contentDivIndex);
    expect(uploadedHtml.indexOf('author-block')).toBeLessThan(contentDivIndex);
    expect(uploadedHtml.indexOf('hero.png')).toBeLessThan(contentDivIndex);

    // Article content should be INSIDE div.content
    expect(uploadedHtml.indexOf('Direct answer paragraph')).toBeGreaterThan(contentDivIndex);
    expect(uploadedHtml.indexOf('tldr-box')).toBeGreaterThan(contentDivIndex);
    expect(uploadedHtml.indexOf('First Section')).toBeGreaterThan(contentDivIndex);
    expect(uploadedHtml.indexOf('Section content')).toBeGreaterThan(contentDivIndex);
  });

  it('should strip <script> tags during restructuring', async () => {
    const htmlWithScripts = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <h1>Title</h1>
  <p>Content</p>
  <script>console.log('remove me');</script>
  <script src="external.js"></script>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: htmlWithScripts });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);

    const uploadedHtml = getUploadedHtml();
    expect(uploadedHtml).not.toContain('<script');
    expect(uploadedHtml).not.toContain('remove me');
    expect(uploadedHtml).not.toContain('external.js');
    expect(uploadedHtml).toContain('Content');
  });

  it('should NOT restructure HTML that already has <div class="content">', async () => {
    const htmlWithContentDiv = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <h1>Title</h1>
  <div class="content">
    <p>Already structured content</p>
  </div>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: htmlWithContentDiv });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);
    expect(result.structureRepaired).toBe(false);
    expect(result.message).not.toContain('HTML restructured');
  });

  it('should preserve <style> blocks in <head> during restructuring', async () => {
    const htmlWithStyles = `<!DOCTYPE html>
<html>
<head>
  <title>Test</title>
  <style>
    .stat-card { background: #f0f0f0; }
    .tldr-box { border-left: 4px solid blue; }
  </style>
</head>
<body>
  <h1>Title</h1>
  <div class="stat-card">Some stat</div>
  <div class="tldr-box">TL;DR</div>
</body>
</html>`;

    mockAxiosGet.mockResolvedValue({ data: htmlWithStyles });

    const result = await (agentModeService as any).repairBlogArticle(
      mockArticleUrl,
      mockUserId,
      mockSessionId
    );

    expect(result.success).toBe(true);
    expect(result.structureRepaired).toBe(true);

    const uploadedHtml = getUploadedHtml();
    // Styles should still be in <head>
    expect(uploadedHtml).toContain('.stat-card');
    expect(uploadedHtml).toContain('.tldr-box');
    // Content should be wrapped
    expect(uploadedHtml).toContain('<div class="content">');
    expect(uploadedHtml).toContain('Some stat');
  });
});
