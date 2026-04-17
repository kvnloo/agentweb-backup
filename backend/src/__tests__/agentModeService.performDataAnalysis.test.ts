import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';
import { uploadFileToS3 } from '../utils/s3Utils';
import { getSecret } from '../utils/secretsManager';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://example.com/upload.png'
  })
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn()
}));

const mockedAxiosGet = axios.get as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;
const mockedUploadFileToS3 = uploadFileToS3 as jest.Mock;
const mockedGetSecret = getSecret as jest.Mock;

describe('AgentModeService.performDataAnalysis', () => {
  let service: AgentModeService;

  beforeAll(() => {
    process.env.AZURE_OPENAI_API_KEY = 'test-openai-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://azure.test';
    process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE = 'gpt-test';
    process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE = '2025-01-01-preview';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DATA_ANALYSIS_FILE_SIZE;
    mockedGetSecret.mockResolvedValue('test-gemini-key');
    service = new AgentModeService();
  });

  test('returns error when analysis instruction is missing', async () => {
    const result = await (service as any).performDataAnalysis([], '', 'user-1');

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Analysis instruction is required'
      })
    );
  });

  test('returns error when Gemini API key cannot be retrieved', async () => {
    mockedGetSecret.mockRejectedValueOnce(new Error('Secret missing'));

    const result = await (service as any).performDataAnalysis([], 'Analyze the provided dataset', 'user-1');

    expect(mockedGetSecret).toHaveBeenCalledWith('dev/AgentWeb/GeminiAPIKey');
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Failed to retrieve Gemini API key from Secrets Manager'
      })
    );
  });

  test('returns error when file download fails', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('Network error'));

    const result = await (service as any).performDataAnalysis(['https://files.test/sample.csv'], 'Analyze sales trends', 'user-1');

    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'https://files.test/sample.csv',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 30000 })
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Failed to download or process file: https://files.test/sample.csv',
        error: 'Network error'
      })
    );
  });

  test('returns error when total file size exceeds limit', async () => {
    process.env.DATA_ANALYSIS_FILE_SIZE = '10'; // 10 bytes
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('more-than-ten-bytes'),
      headers: {}
    });

    const result = await (service as any).performDataAnalysis(['https://files.test/large.csv'], 'Analyze the dataset', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Total file size');
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  test('succeeds when no files are provided and analysis runs on instruction data', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Summary of analysis results.' }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Dataset: value, value\nPlease summarize.', 'user-1');

    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const postBody = mockedAxiosPost.mock.calls[0][1];
    expect(postBody.contents[0].parts[0].text).toContain('No external files are attached');
    expect(result.success).toBe(true);
    expect(result.analysis).toContain('**Analysis:** Summary of analysis results.');
  });

  test('Gemini API call includes a request timeout to prevent indefinite hangs', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [{ text: 'Result.' }]
            }
          }
        ]
      }
    });

    await (service as any).performDataAnalysis([], 'Summarize.', 'user-1');

    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const postConfig = mockedAxiosPost.mock.calls[0][2]; // third arg is axios config
    expect(postConfig).toBeDefined();
    expect(typeof postConfig.timeout).toBe('number');
    expect(postConfig.timeout).toBeGreaterThan(0);
  });

  test('uploads inline chart data when present in response', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('csv-data'),
      headers: { 'content-type': 'text/csv' }
    });

    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Analysis includes chart output.' },
                {
                  inlineData: {
                    data: Buffer.from('image-bytes').toString('base64'),
                    mimeType: 'image/png'
                  }
                }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis(
      ['https://files.test/data.csv'],
      'Analyze the uploaded CSV and produce summary statistics.',
      'user-42'
    );

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockedUploadFileToS3).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/analysis_chart_\d+\.png/),
      'user-42',
      'image/png'
    );
    expect(result.success).toBe(true);
    expect(result.analysis).toContain('**Analysis:** Analysis includes chart output.');
    expect(result.analysis).toContain('![Analysis Result](');
  });
});
