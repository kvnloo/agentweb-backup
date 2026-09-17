import { AgentModeService } from '../services/agentModeService';

// ENG-1997 round 2 — an independent review found `uploadUpdatedFile` (the
// shared S3 upload sink for BOTH updateHtmlFile's part/full replacements and
// updateHtmlFileCss's selector-based edits) had zero HTML sanitization. Its
// `setAttribute` CSS-selector action lets the model set an arbitrary
// attribute name/value pair directly (e.g. onerror/onclick) and its
// replace/append/etc. actions splice raw HTML with no escaping — the same
// "LLM-authored HTML reaches a public S3 file unsanitized" gap createHtmlFile
// had, one step more direct. These tests exercise the REAL uploadUpdatedFile
// method (not mocked, unlike updateHtmlFile.cssSelector.test.ts's suite,
// which mocks it away and so never exercised this) to prove the fix.
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

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/updated_file_v2.html',
  }),
}));

describe('AgentModeService.uploadUpdatedFile — ENG-1997 round 2 (sanitize the shared update-tools upload sink)', () => {
  let service: AgentModeService;
  let mockUpload: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockUpload = require('../utils/s3Utils').uploadFileToS3WithPath;
  });

  it('strips a script tag spliced in via a CSS-selector append/replace action', async () => {
    const content = '<html><body><div id="x">Feedback: <script>alert(1)</script></div></body></html>';
    await service.uploadUpdatedFile(content, 'file_v2.html', 'users/u1/files/file.html');

    const [uploaded] = mockUpload.mock.calls[0];
    expect(uploaded).not.toContain('<script');
  });

  it('strips an onerror attribute set directly via setAttribute', async () => {
    const content = '<html><body><img src="x" onerror="alert(1)"></body></html>';
    await service.uploadUpdatedFile(content, 'file_v2.html', 'users/u1/files/file.html');

    const [uploaded] = mockUpload.mock.calls[0];
    expect(uploaded).not.toMatch(/onerror/i);
  });

  it('strips a javascript: href set directly via setAttribute', async () => {
    const content = '<html><body><a href="javascript:alert(1)">click</a></body></html>';
    await service.uploadUpdatedFile(content, 'file_v2.html', 'users/u1/files/file.html');

    const [uploaded] = mockUpload.mock.calls[0];
    expect(uploaded).not.toMatch(/javascript:/i);
  });

  it('leaves benign updated content unchanged in meaning and passes filename/path through', async () => {
    const content = '<html><body><div class="speaker-card">Alice Johnson</div></body></html>';
    const result = await service.uploadUpdatedFile(content, 'file_v2.html', 'users/u1/files/file.html');

    expect(result.url).toBe('https://s3.amazonaws.com/bucket/updated_file_v2.html');
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringContaining('Alice Johnson'),
      'file_v2.html',
      'text/html',
      'users/u1/files/file.html',
    );
  });
});
