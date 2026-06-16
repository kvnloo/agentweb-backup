import { AgentModeService } from '../services/agentModeService';
import { getS3ObjectAsString } from '../utils/s3Utils';

// Only the S3 retrieve helper matters for these handler-level tests.
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  uploadFileToS3WithPath: jest.fn(),
  uploadScreenshotToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})),
}));

const mockedGetS3 = getS3ObjectAsString as jest.Mock;

/**
 * Tests for the search_tool_response / read_tool_response S3 RETRIEVE handlers.
 *
 * Production telemetry (Dev-AW-LoopEvents, agent_tool_failed, last 7d) showed these
 * two tools as the #1 fixable internal failure cluster (61 combined failures). The
 * dispatch layer counts ANY handler result with `success === false` as an
 * agent_tool_failed event, so a benign "no match" / "key expired" / "empty object"
 * outcome that returned `success:false` was being recorded as a failure. These tests
 * pin the corrected behavior: benign retrieval misses are model-actionable and
 * `success:true` (NOT counted as failures), real errors stay `success:false`, and
 * the normal success path is unchanged.
 */
describe('AgentModeService tool-response retrieve handlers', () => {
  let service: AgentModeService;

  beforeAll(() => {
    process.env.AZURE_OPENAI_API_KEY = 'test-openai-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://azure.test';
    process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE = 'gpt-test';
    process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE = '2025-01-01-preview';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  describe('executeSearchToolResponse', () => {
    it('returns matches on the success path (behavior-preserving)', async () => {
      mockedGetS3.mockResolvedValueOnce('the link_url is https://example.com and another link_url here');
      const result = await (service as any).executeSearchToolResponse({
        s3_key: 'tool-responses/abc',
        query: 'link_url',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches_found).toBe(2);
      expect(result.matches_returned).toBe(2);
      expect(result.matches[0].context).toContain('link_url');
      // success path returns no guidance message
      expect(result.message).toBeUndefined();
    });

    it('zero matches is success:true with guidance (NOT a failure)', async () => {
      mockedGetS3.mockResolvedValueOnce('some content without the term');
      const result = await (service as any).executeSearchToolResponse({
        s3_key: 'tool-responses/abc',
        query: 'nonexistent_field',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches_found).toBe(0);
      expect(result.matches).toEqual([]);
      expect(result.message).toMatch(/No matches/i);
    });

    it('empty stored object is success:true with guidance (NOT a failure)', async () => {
      mockedGetS3.mockResolvedValueOnce('');
      const result = await (service as any).executeSearchToolResponse({
        s3_key: 'tool-responses/abc',
        query: 'anything',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches_found).toBe(0);
      expect(result.message).toMatch(/empty/i);
    });

    it('NoSuchKey (expired/missing key) is graceful success:true with stop-retrying guidance (NOT a failure)', async () => {
      mockedGetS3.mockRejectedValueOnce(
        Object.assign(new Error('The specified key does not exist. NoSuchKey'), { code: 'NoSuchKey' }),
      );
      const result = await (service as any).executeSearchToolResponse({
        s3_key: 'tool-responses/gone',
        query: 'anything',
      });

      expect(result.success).toBe(true);
      expect(result.not_found).toBe(true);
      expect(result.message).toMatch(/no longer available/i);
      expect(result.message).toMatch(/Do NOT retry/i);
    });

    it('an unexpected/transient error after retries IS a real failure (success:false)', async () => {
      mockedGetS3.mockRejectedValueOnce(new Error('connection reset by peer'));
      const result = await (service as any).executeSearchToolResponse({
        s3_key: 'tool-responses/abc',
        query: 'anything',
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Failed to search tool response/i);
    });

    it('still validates required args at the handler boundary', async () => {
      const result = await (service as any).executeSearchToolResponse({ s3_key: '', query: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('executeReadToolResponse', () => {
    it('returns a slice on the success path (behavior-preserving)', async () => {
      mockedGetS3.mockResolvedValueOnce('0123456789abcdef');
      const result = await (service as any).executeReadToolResponse({
        s3_key: 'tool-responses/abc',
        char_offset: 0,
        char_length: 5,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('01234');
      expect(result.chars_returned).toBe(5);
      expect(result.total_size).toBe(16);
      expect(result.has_more).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it('empty stored object is success:true with guidance (NOT a failure)', async () => {
      mockedGetS3.mockResolvedValueOnce('');
      const result = await (service as any).executeReadToolResponse({ s3_key: 'tool-responses/abc' });

      expect(result.success).toBe(true);
      expect(result.content).toBe('');
      expect(result.message).toMatch(/empty/i);
    });

    it('offset past end returns success:true with guidance (NOT a failure)', async () => {
      mockedGetS3.mockResolvedValueOnce('short');
      const result = await (service as any).executeReadToolResponse({
        s3_key: 'tool-responses/abc',
        char_offset: 1000,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('');
      expect(result.message).toMatch(/beyond the end|already been read/i);
    });

    it('NoSuchKey is graceful success:true with stop-retrying guidance (NOT a failure)', async () => {
      mockedGetS3.mockRejectedValueOnce(
        Object.assign(new Error('Access Denied'), { code: 'AccessDenied' }),
      );
      const result = await (service as any).executeReadToolResponse({ s3_key: 'tool-responses/gone' });

      expect(result.success).toBe(true);
      expect(result.not_found).toBe(true);
      expect(result.message).toMatch(/Do NOT retry/i);
    });

    it('an unexpected error after retries IS a real failure (success:false)', async () => {
      mockedGetS3.mockRejectedValueOnce(new Error('totally unexpected'));
      const result = await (service as any).executeReadToolResponse({ s3_key: 'tool-responses/abc' });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Failed to read tool response/i);
    });
  });

  describe('MANDATORY_FOUNDATION_TOOLS', () => {
    it('always includes the S3 overflow retrieve tools so config cannot strip them', () => {
      const mandatory: ReadonlyArray<string> = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS;
      expect(mandatory).toContain('search_tool_response');
      expect(mandatory).toContain('read_tool_response');
    });
  });
});
