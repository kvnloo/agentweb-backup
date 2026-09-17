import { AgentModeService } from '../services/agentModeService';
import { SsrfBlockedError } from '../utils/ssrfGuard';

// Mock all dependencies (mirrors agentModeService.convertToPdfFoundation.test.ts)
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getAllSkills: jest.fn().mockResolvedValue([]),
    createSkill: jest.fn().mockResolvedValue(undefined),
    updateSkill: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(),
  })),
}));

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../services/pdfRenderService', () => ({
  renderHtmlToPdf: jest.fn(),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('../utils/ssrfGuard', () => {
  const actual = jest.requireActual('../utils/ssrfGuard');
  return {
    ...actual,
    assertPublicHostname: jest.fn(),
  };
});

import { renderHtmlToPdf } from '../services/pdfRenderService';
import { uploadFileToS3 } from '../utils/s3Utils';
import { assertPublicHostname } from '../utils/ssrfGuard';

const mockRenderHtmlToPdf = renderHtmlToPdf as jest.MockedFunction<typeof renderHtmlToPdf>;
const mockUploadFileToS3 = uploadFileToS3 as jest.MockedFunction<typeof uploadFileToS3>;
const mockAssertPublicHostname = assertPublicHostname as jest.MockedFunction<typeof assertPublicHostname>;

describe('AgentModeService.convertToPdf — SSRF guard (ENG-1867)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    mockRenderHtmlToPdf.mockResolvedValue({
      buffer: Buffer.from('%PDF-fake'),
      orientation: 'portrait',
      scale: 1,
      honoredAuthoredPageSize: false,
    } as any);
    mockUploadFileToS3.mockResolvedValue({
      success: true,
      url: 'https://s3.example.com/export.pdf',
    } as any);
  });

  it('rejects a source_url that resolves to a private/internal address before rendering', async () => {
    mockAssertPublicHostname.mockRejectedValue(new SsrfBlockedError());

    const result = await agentModeService.convertToPdf(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/role',
      'brief.html',
      'user-1'
    );

    expect(mockAssertPublicHostname).toHaveBeenCalledWith(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/role'
    );
    expect(mockRenderHtmlToPdf).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('renders and uploads for a source_url that passes the public-hostname check', async () => {
    mockAssertPublicHostname.mockResolvedValue(undefined);

    const result = await agentModeService.convertToPdf(
      'https://app.agentweb.pro/brief.html',
      'brief.html',
      'user-1'
    );

    expect(mockAssertPublicHostname).toHaveBeenCalledWith('https://app.agentweb.pro/brief.html');
    expect(mockRenderHtmlToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://app.agentweb.pro/brief.html' })
    );
    expect(result.success).toBe(true);
    expect(result.pdf_url).toBe('https://s3.example.com/export.pdf');
  });
});
