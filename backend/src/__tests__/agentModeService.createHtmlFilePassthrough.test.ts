import { AgentModeService } from '../services/agentModeService';

// Mirror the mock set used by the other AgentModeService loop tests so the
// module graph loads cleanly (do NOT mock axios/aws-sdk — that breaks the
// transitive Slack WebClient construction at import time).
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

// The internal render step we want to prove is skipped for already-complete HTML.
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn().mockReturnValue({
    generateHTML: jest.fn().mockResolvedValue('<html><body>RENDERED BY LLM</body></html>'),
  }),
}));

// Capture what content actually gets uploaded.
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/html_test.html',
  }),
}));

jest.mock('../utils/inlineS3Images', () => ({
  createDefaultS3ImageFetcher: jest.fn().mockReturnValue(jest.fn()),
  inlineS3ImagesAsDataUris: jest.fn().mockImplementation(async (html: string) => ({
    html,
    inlined: 0,
    decodedBytes: 0,
  })),
}));

const COMPLETE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Acme</title><style>body{font-family:Inter}</style></head>
<body><h1>Acme Insight</h1><p>Real content here.</p></body>
</html>`;

describe('AgentModeService.createHtmlFile — ENG-472 (skip redundant render / fail fast)', () => {
  let service: AgentModeService;
  let mockGenerateHTML: jest.Mock;
  let mockUpload: jest.Mock;
  let mockInlineImages: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    jest.spyOn(service as any, 'makeToolUsageCallback').mockReturnValue(() => {});
    mockGenerateHTML = require('../utils/llmService').createLLMService().generateHTML;
    mockUpload = require('../utils/s3Utils').uploadFileToS3;
    mockInlineImages = require('../utils/inlineS3Images').inlineS3ImagesAsDataUris;
  });

  it('uploads an already-complete HTML document directly, WITHOUT calling the render LLM', async () => {
    const res = await service.createHtmlFile('Acme Insight', COMPLETE_HTML, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(res.s3_url).toContain('https://');
    // The render LLM must NOT be invoked for already-complete HTML.
    expect(mockGenerateHTML).not.toHaveBeenCalled();
    // The user's exact HTML must be uploaded verbatim (not re-generated / altered).
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0]).toBe(COMPLETE_HTML);
  });

  it('passthrough works for arbitrarily LARGE complete HTML (the timeout case) without rendering', async () => {
    const big = COMPLETE_HTML.replace('</body>', '<p>' + 'x'.repeat(120_000) + '</p></body>');
    const res = await service.createHtmlFile('Big Guide', big, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(mockGenerateHTML).not.toHaveBeenCalled();
    expect(mockUpload.mock.calls[0][0]).toBe(big);
  });

  it('inlines private images before uploading a complete HTML document', async () => {
    const inlined = COMPLETE_HTML.replace(
      '<p>Real content here.</p>',
      '<img src="data:image/png;base64,aW1hZ2U=">',
    );
    mockInlineImages.mockResolvedValueOnce({ html: inlined, inlined: 1, decodedBytes: 5 });

    const res = await service.createHtmlFile('Acme Insight', COMPLETE_HTML, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(require('../utils/inlineS3Images').createDefaultS3ImageFetcher)
      .toHaveBeenCalledWith('user-1');
    expect(mockInlineImages).toHaveBeenCalledWith(COMPLETE_HTML, expect.any(Function));
    expect(mockUpload).toHaveBeenCalledWith(inlined, expect.any(String), 'user-1', 'text/html');
  });

  it('fails with actionable image guidance and does not upload a partial document', async () => {
    mockInlineImages.mockRejectedValueOnce(new Error(
      'Private image exceeds the 5 MB decoded limit: reports/chart.png. Reduce the image size and retry.',
    ));

    const res = await service.createHtmlFile('Acme Insight', COMPLETE_HTML, '', 'user-1', 'sess-1', 'document');

    expect(res).toMatchObject({
      success: false,
      error: expect.stringMatching(/5 MB.*reports\/chart\.png.*reduce the image size/i),
    });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('still RENDERS a small non-HTML draft via the LLM (no regression)', async () => {
    const res = await service.createHtmlFile('Summary', 'Just a few plain sentences about email marketing.', '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(mockGenerateHTML).toHaveBeenCalledTimes(1);
    // The rendered (LLM) output is uploaded, not the raw draft.
    expect(mockUpload.mock.calls[0][0]).toContain('RENDERED BY LLM');
  });

  it('inlines private images in rendered documents before upload', async () => {
    mockInlineImages.mockResolvedValueOnce({
      html: '<html><body>RENDERED WITH DATA URI</body></html>',
      inlined: 1,
      decodedBytes: 5,
    });

    const res = await service.createHtmlFile('Summary', 'Render this draft.', '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(mockInlineImages).toHaveBeenCalledWith(
      '<html><body>RENDERED BY LLM</body></html>',
      expect.any(Function),
    );
    expect(mockUpload.mock.calls[0][0]).toContain('RENDERED WITH DATA URI');
  });

  it('still RENDERS an email even when the draft is already complete HTML (email-safety must run)', async () => {
    const res = await service.createHtmlFile('Newsletter', COMPLETE_HTML, '', 'user-1', 'sess-1', 'email');

    expect(res.success).toBe(true);
    expect(mockGenerateHTML).toHaveBeenCalledTimes(1);
    expect(mockInlineImages).not.toHaveBeenCalled();
  });

  it('still RENDERS incomplete HTML (no closing </html>) rather than passing a broken fragment through', async () => {
    const partial = '<!DOCTYPE html><html><body><h1>Cut off mid';
    const res = await service.createHtmlFile('Partial', partial, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(mockGenerateHTML).toHaveBeenCalledTimes(1);
  });

  // ENG-472 made an oversized draft fail fast instead of burning ~15 minutes on
  // renders that cannot finish. ENG-873 keeps the "spend nothing on the LLM"
  // half and drops the "deliver nothing" half: a deterministic render has no
  // size ceiling, so the completed work still comes back as a file.
  it('delivers an oversized NON-HTML draft deterministically instead of returning nothing', async () => {
    const huge = 'This is a long plain-text chapter. '.repeat(3000); // ~105K chars, not HTML
    const res = await service.createHtmlFile('Mega Guide', huge, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.s3_url).toBeDefined();
    // No LLM spend: the whole point of the ENG-472 ceiling.
    expect(mockGenerateHTML).not.toHaveBeenCalled();
    expect((res.message || '').toLowerCase()).toMatch(/too large|split|smaller/);

    const [uploadedContent] = (mockUpload as jest.Mock).mock.calls[0];
    expect(uploadedContent.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(uploadedContent).toContain('long plain-text chapter');
  });

  it('inlines private images in deterministic fallback documents before upload', async () => {
    const huge = '![Chart](https://agentweb-user-files.s3.amazonaws.com/chart.png)\n'.repeat(2000);
    mockInlineImages.mockResolvedValueOnce({
      html: '<!DOCTYPE html><html><body><img src="data:image/png;base64,aW1hZ2U="></body></html>',
      inlined: 1,
      decodedBytes: 5,
    });

    const res = await service.createHtmlFile('Large report', huge, '', 'user-1', 'sess-1', 'document');

    expect(res.success).toBe(true);
    expect(res.degraded).toBe(true);
    expect(mockInlineImages).toHaveBeenCalledWith(expect.stringContaining('<!DOCTYPE html>'), expect.any(Function));
    expect(mockUpload.mock.calls[0][0]).toContain('data:image/png;base64,aW1hZ2U=');
  });
});
