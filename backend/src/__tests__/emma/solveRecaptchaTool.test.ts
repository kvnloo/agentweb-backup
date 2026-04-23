import '../../emma/solveRecaptchaTool';
import { emmaToolRegistry } from '../../emma/registry';

const tool = emmaToolRegistry.getTool('solve_captcha');
if (!tool) throw new Error('solve_captcha tool not registered');

const mockContext = {
  userId: 'user-123',
  sessionId: 'session-abc',
  llmModel: 'test-model',
  service: {}
};

describe('solve_captcha validation', () => {
  it('returns error when all required args are missing', async () => {
    const result = await tool.execute({}, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
    expect(result.error).toContain('site_key');
    expect(result.error).toContain('page_url');
    expect(result.error).toContain('browser_evaluate');
  });

  it('returns error when args is null/undefined', async () => {
    const result = await tool.execute(null, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
  });

  it('returns error when captcha_type is missing', async () => {
    const result = await tool.execute({ site_key: 'abc', page_url: 'https://example.com' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('captcha_type');
    expect(result.error).not.toContain('site_key');
    expect(result.error).not.toContain('page_url');
  });

  it('returns error when site_key is missing', async () => {
    const result = await tool.execute({ captcha_type: 'recaptcha_v2', page_url: 'https://example.com' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('site_key');
  });

  it('returns error when page_url is missing', async () => {
    const result = await tool.execute({ captcha_type: 'recaptcha_v2', site_key: 'abc123' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('page_url');
  });

  it('includes browser_evaluate JS snippet in error for discoverability', async () => {
    const result = await tool.execute({}, mockContext);
    expect(result.error).toContain('data-sitekey');
    expect(result.error).toContain('browser_evaluate');
  });

  it('throws when userId is missing (even with all args)', async () => {
    await expect(
      tool.execute({ captcha_type: 'recaptcha_v2', site_key: 'key', page_url: 'https://example.com' }, { ...mockContext, userId: undefined })
    ).rejects.toThrow('Authentication required');
  });

  it('rejects unknown captcha_type (passes validation, hits switch default)', async () => {
    await expect(
      tool.execute({ captcha_type: 'image_captcha', site_key: 'key', page_url: 'https://example.com' }, mockContext)
    ).rejects.toThrow(/Unknown captcha_type/);
  });
});
