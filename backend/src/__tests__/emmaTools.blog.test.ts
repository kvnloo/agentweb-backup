/**
 * ENG-2103 F2 — proves emma/tools.ts's blog tool execute() bodies call
 * emma/impl/blog.ts directly (not agentModeService.<method>) and forward the
 * result unchanged. Same pattern as emmaTools.knowledgeBase.test.ts /
 * emmaTools.leads.test.ts.
 */

jest.mock('../emma/impl/blog', () => ({
  createBlogArticle: jest.fn(),
  publishBlogArticle: jest.fn(),
  repairBlogArticle: jest.fn(),
}));

// agentModeService.<blogMethod> must NOT be called by these tools anymore —
// mock the whole module so a regression (a call site accidentally left
// pointed at the class) would throw instead of silently succeeding against
// the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the blog tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as blogImpl from '../emma/impl/blog';
import '../emma/tools';

const mockBlog = blogImpl as jest.Mocked<typeof blogImpl>;

describe('Blog tool cluster delegates to emma/impl/blog.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create_blog_article forwards args/userId/sessionId and returns the result unchanged', async () => {
    const expected = { success: true, data: { title: 'T', htmlUrl: 'https://s3/x.html' } };
    mockBlog.createBlogArticle.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_blog_article')!;
    const result = await tool.execute(
      {
        title_draft: 'Draft title',
        content_draft: 'Draft content',
        length: 'short',
        researchContext: 'ctx',
        requirements: 'reqs',
        style: 'substack',
        deep_research: true,
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockBlog.createBlogArticle).toHaveBeenCalledWith(
      'Draft title', 'Draft content', 'short', 'ctx', 'reqs', 'u1', 's1', 'substack', true
    );
    expect(result).toBe(expected);
  });

  it('create_blog_article applies defaults for optional args', async () => {
    const expected = { success: true };
    mockBlog.createBlogArticle.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_blog_article')!;
    await tool.execute({ title_draft: 'T', content_draft: 'C' }, { userId: 'u1', sessionId: 's1' });

    expect(mockBlog.createBlogArticle).toHaveBeenCalledWith(
      'T', 'C', 'medium', '', '', 'u1', 's1', 'default', false
    );
  });

  it('publish_blog_article forwards args and the assertPublishStillAuthorized hook, and returns the result unchanged', async () => {
    const expected = { success: true, message: 'published' };
    mockBlog.publishBlogArticle.mockResolvedValue(expected);
    const sentinel = jest.fn(async () => null);

    const tool = emmaToolRegistry.getTool('publish_blog_article')!;
    const result = await tool.execute(
      {
        title: 'T',
        description: 'D',
        hero_image_url: 'https://s3/hero.png',
        blog_html_url: 'https://s3/x.html',
        status: 'published',
        author: 'Author',
        categories: ['news'],
      },
      { userId: 'u1', sessionId: 's1', assertPublishStillAuthorized: sentinel }
    );

    expect(mockBlog.publishBlogArticle).toHaveBeenCalledWith(
      'T', 'D', 'https://s3/hero.png', 'https://s3/x.html', 'u1', 's1', 'published', 'Author', ['news'], sentinel
    );
    expect(result).toBe(expected);
  });

  it('repair_blog_article forwards article_url/userId/sessionId and returns the result unchanged', async () => {
    const expected = { success: true, repairedArticleUrl: 'https://s3/repaired.html' };
    mockBlog.repairBlogArticle.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('repair_blog_article')!;
    const result = await tool.execute({ article_url: 'https://s3/x.html' }, { userId: 'u1', sessionId: 's1' });

    expect(mockBlog.repairBlogArticle).toHaveBeenCalledWith('https://s3/x.html', 'u1', 's1');
    expect(result).toBe(expected);
  });
});
