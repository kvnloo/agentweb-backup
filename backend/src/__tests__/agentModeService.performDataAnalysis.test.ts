import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';
import { uploadFileToS3, getS3ObjectAsString } from '../utils/s3Utils';
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
  }),
  getS3ObjectAsString: jest.fn()
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn()
}));

const mockedAxiosGet = axios.get as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;
const mockedUploadFileToS3 = uploadFileToS3 as jest.Mock;
const mockedGetSecret = getSecret as jest.Mock;
const mockedGetS3ObjectAsString = getS3ObjectAsString as jest.Mock;

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

  test('skips inlineData with non-image mimeType (e.g. Vega-Lite JSON from altair)', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here is the chart specification.' },
                {
                  inlineData: {
                    data: Buffer.from('{"$schema":"https://vega.github.io/schema/vega-lite/v5.json"}').toString('base64'),
                    mimeType: 'application/json'
                  }
                }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Create a chart.', 'user-1');

    expect(mockedUploadFileToS3).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.analysis).not.toContain('![Analysis Result]');
  });

  test('skips inline_data (snake_case) with non-image mimeType', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Chart spec generated.' },
                {
                  inline_data: {
                    data: Buffer.from('{"type":"chart"}').toString('base64'),
                    mime_type: 'application/json'
                  }
                }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Create a chart.', 'user-1');

    expect(mockedUploadFileToS3).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.analysis).not.toContain('![Analysis Result]');
  });

  // ─── tool-response S3 key auto-resolution ───────────────────────────────────

  test('auto-resolves tool-response S3 keys in analysis_instruction and proceeds', async () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const s3Key = `tool-responses/${sessionId}/call123.txt`;
    const s3Content = 'sessionId,userId,totalTokens\nsess1,user1,1000\nsess2,user2,2000';

    mockedGetS3ObjectAsString.mockResolvedValueOnce(s3Content);
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [{ content: { parts: [{ text: 'Analysis complete.' }] } }]
      }
    });

    const instruction = `Read from ${s3Key} and compute total tokens per user.`;
    const result = await (service as any).performDataAnalysis([], instruction, 'user-1');

    expect(mockedGetS3ObjectAsString).toHaveBeenCalledWith(s3Key);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const postBody = mockedAxiosPost.mock.calls[0][1];
    const sentInstruction = postBody.contents[0].parts[postBody.contents[0].parts.length - 1].text as string;
    // S3 content should be embedded inline; the raw key reference (as a bare path) is gone
    expect(sentInstruction).toContain(s3Content);
    // The original bare reference "Read from <key>" is replaced — key appears only in the [Content of ...] header
    expect(sentInstruction).not.toContain(`Read from ${s3Key}`);
    expect(result.success).toBe(true);
  });

  test('returns error when tool-response S3 key cannot be read and no keys resolved', async () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const s3Key = `tool-responses/${sessionId}/missing.txt`;

    mockedGetS3ObjectAsString.mockRejectedValueOnce(new Error('NoSuchKey'));

    const instruction = `Analyze the data in ${s3Key}.`;
    const result = await (service as any).performDataAnalysis([], instruction, 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('could not be read');
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  test('rejects local file path references (open, with open) without S3 keys', async () => {
    const instruction = `with open('/home/bard/data.csv') as f: data = f.read()`;
    const result = await (service as any).performDataAnalysis([], instruction, 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('local file paths');
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  // ─── s3:// URL handling ────────────────────────────────────────────────────

  test('downloads file via S3 SDK when file_url uses s3:// scheme', async () => {
    const s3Url = 's3://agentweb-user-files/users/user-1/files/1234/abc/data.csv';
    const csvContent = 'name,value\nfoo,1\nbar,2';

    mockedGetS3ObjectAsString.mockResolvedValueOnce(csvContent);
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [{ content: { parts: [{ text: 'Analysis complete.' }] } }]
      }
    });

    const result = await (service as any).performDataAnalysis([s3Url], 'Summarize the data.', 'user-1');

    expect(mockedGetS3ObjectAsString).toHaveBeenCalledWith('users/user-1/files/1234/abc/data.csv', 'agentweb-user-files');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test('returns error when s3:// URL file cannot be fetched from S3', async () => {
    const s3Url = 's3://agentweb-user-files/users/user-1/files/missing.csv';

    mockedGetS3ObjectAsString.mockRejectedValueOnce(new Error('NoSuchKey'));

    const result = await (service as any).performDataAnalysis([s3Url], 'Summarize.', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain(s3Url);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  test('returns error when s3:// URL has no key path', async () => {
    const s3Url = 's3://agentweb-user-files';

    const result = await (service as any).performDataAnalysis([s3Url], 'Summarize.', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain(s3Url);
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  test('handles mixed s3:// and https:// URLs in the same call', async () => {
    const s3Url = 's3://agentweb-user-files/users/user-1/files/1234/abc/data.csv';
    const httpsUrl = 'https://example.com/extra.csv';
    const csvContent = 'name,value\nfoo,1';

    mockedGetS3ObjectAsString.mockResolvedValueOnce(csvContent);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('col1,col2\na,b'),
      headers: { 'content-type': 'text/csv' }
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [{ content: { parts: [{ text: 'Done.' }] } }]
      }
    });

    const result = await (service as any).performDataAnalysis([s3Url, httpsUrl], 'Summarize both.', 'user-1');

    expect(mockedGetS3ObjectAsString).toHaveBeenCalledTimes(1);
    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test('prompt instructs Gemini to use matplotlib, not altair', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [{ text: 'Done.' }]
            }
          }
        ]
      }
    });

    await (service as any).performDataAnalysis([], 'Generate a bar chart.', 'user-1');

    const postBody = mockedAxiosPost.mock.calls[0][1];
    const promptText = postBody.contents[0].parts[postBody.contents[0].parts.length - 1].text as string;
    expect(promptText).toContain('matplotlib');
    expect(promptText).toContain('altair');
    expect(promptText.toLowerCase()).toContain('do not use altair');
  });

  test('returns chunking guidance when axios times out (ECONNABORTED)', async () => {
    const timeoutError = new Error('timeout of 1200000ms exceeded');
    (timeoutError as any).code = 'ECONNABORTED';
    mockedAxiosPost.mockRejectedValueOnce(timeoutError);

    const result = await (service as any).performDataAnalysis([], 'Analyze the dataset.', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('timed out');
    expect(result.message).toContain('smaller pieces');
  });

  test('returns chunking guidance when error message contains "timeout"', async () => {
    mockedAxiosPost.mockRejectedValueOnce(new Error('Request timeout after 20 minutes'));

    const result = await (service as any).performDataAnalysis([], 'Analyze the dataset.', 'user-1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('timed out');
  });

  // ─── sandbox file materialization (text/csv mime + on-disk filenames) ───────
  // Gemini code_execution only writes a file part to the sandbox filesystem when
  // its mimeType is text/csv. application/json is rejected (HTTP 400) and
  // text/plain is silently NOT written to disk. So every file MUST be sent as
  // text/csv regardless of its real content type, and the model must be told the
  // exact on-disk filenames so it reads from disk instead of inlining/truncating.

  const onlyFileParts = (postBody: any): any[] =>
    (postBody.contents[0].parts as any[]).filter(p => p.inlineData || p.inline_data);
  const promptTextOf = (postBody: any): string => {
    const parts = postBody.contents[0].parts as any[];
    return parts[parts.length - 1].text as string;
  };

  test('sends a .json tool-response file to Gemini as text/csv so it materializes on disk', async () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const s3Key = `tool-responses/${sessionId}/get_chat_history.json`;
    mockedGetS3ObjectAsString.mockResolvedValueOnce('{"sessions":[{"cost":1.5}],"total":1.5}');
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    const result = await (service as any).performDataAnalysis([s3Key], 'Total the cost.', 'user-1');

    expect(result.success).toBe(true);
    const fileParts = onlyFileParts(mockedAxiosPost.mock.calls[0][1]);
    expect(fileParts).toHaveLength(1);
    const part = fileParts[0];
    const mime = part.inlineData?.mimeType ?? part.inline_data?.mime_type;
    expect(mime).toBe('text/csv');
  });

  test('sends an https .txt file to Gemini as text/csv (text/plain would not materialize)', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('plain text tool response payload'),
      headers: { 'content-type': 'text/plain' }
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis(['https://files.test/data.txt'], 'Summarize.', 'user-1');

    const fileParts = onlyFileParts(mockedAxiosPost.mock.calls[0][1]);
    const mime = fileParts[0].inlineData?.mimeType ?? fileParts[0].inline_data?.mime_type;
    expect(mime).toBe('text/csv');
  });

  test('tells the model the exact on-disk filename (input_file_0.csv) for a provided file', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('col1,col2\na,b'),
      headers: { 'content-type': 'text/csv' }
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis(['https://files.test/data.csv'], 'Summarize.', 'user-1');

    const prompt = promptTextOf(mockedAxiosPost.mock.calls[0][1]);
    expect(prompt).toContain('input_file_0.csv');
    // Must instruct reading from disk, not relying on inline data
    expect(prompt.toLowerCase()).toContain('read');
  });

  test('numbers multiple files input_file_0.csv and input_file_1.csv in the prompt', async () => {
    const s3Url = 's3://agentweb-user-files/users/user-1/files/1234/abc/data.csv';
    mockedGetS3ObjectAsString.mockResolvedValueOnce('name,value\nfoo,1');
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from('col1,col2\na,b'),
      headers: { 'content-type': 'text/csv' }
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis([s3Url, 'https://files.test/extra.csv'], 'Summarize both.', 'user-1');

    const prompt = promptTextOf(mockedAxiosPost.mock.calls[0][1]);
    expect(prompt).toContain('input_file_0.csv');
    expect(prompt).toContain('input_file_1.csv');
  });

  // ─── generated file capture (marker protocol → real S3 download URL) ────────
  // Gemini's sandbox discards on-disk files and only returns inline images, so the
  // model is told to print a generated file's full contents between AGENTWEB_FILE
  // markers. The backend extracts that content, uploads it to S3, and returns a real
  // download link instead of a fabricated bare filename / fake S3 key / sandbox: path.

  test('prompt instructs the model to print files between AGENTWEB_FILE markers and not invent URLs', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis([], 'Save the results as a CSV.', 'user-1');

    const postBody = mockedAxiosPost.mock.calls[0][1];
    const prompt = postBody.contents[0].parts[postBody.contents[0].parts.length - 1].text as string;
    expect(prompt).toContain('<<<AGENTWEB_FILE:');
    expect(prompt).toContain('<<<AGENTWEB_FILE_END>>>');
    expect(prompt.toLowerCase()).toContain('do not invent');
    expect(prompt.toLowerCase()).toContain('sandbox:/');
  });

  test('captures a file printed to code execution stdout and returns a real S3 download link', async () => {
    mockedUploadFileToS3.mockResolvedValueOnce({
      success: true,
      url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-7/files/123/abc/seed.csv',
      key: 'users/user-7/files/123/abc/seed.csv'
    });

    const csv = 'email,score\na@x.com,9\nb@y.com,8';
    const stdout = `Wrote file.\n<<<AGENTWEB_FILE:seed.csv>>>\n${csv}\n<<<AGENTWEB_FILE_END>>>\nDone.`;

    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Built the seed audience.' },
                { codeExecutionResult: { outcome: 'OUTCOME_OK', output: stdout } }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Build a seed audience and save as seed.csv.', 'user-7');

    expect(mockedUploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(csv, 'utf-8'),
      'seed.csv',
      'user-7',
      'text/csv'
    );
    expect(result.success).toBe(true);
    expect(result.analysis).toContain('**Generated Files:**');
    expect(result.analysis).toContain('[seed.csv](https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-7/files/123/abc/seed.csv)');
    expect(result.fileUrls).toEqual([
      '**File saved:** [seed.csv](https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-7/files/123/abc/seed.csv)'
    ]);
  });

  test('captures a file printed in a text part (snake_case code_execution_result also handled)', async () => {
    mockedUploadFileToS3.mockResolvedValueOnce({
      success: true,
      url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/1/x/out.json',
      key: 'users/user-1/files/1/x/out.json'
    });

    const json = '{"total": 42}';
    const text = `Here are the results.\n<<<AGENTWEB_FILE:out.json>>>\n${json}\n<<<AGENTWEB_FILE_END>>>`;

    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text }] } }] }
    });

    const result = await (service as any).performDataAnalysis([], 'Save totals as out.json.', 'user-1');

    expect(mockedUploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(json, 'utf-8'),
      'out.json',
      'user-1',
      'application/json'
    );
    expect(result.success).toBe(true);
    // The raw file contents must be stripped from the analysis text (replaced by a reference)
    expect(result.analysis).not.toContain('{"total": 42}');
    expect(result.analysis).toContain('[Generated file: out.json — download link below]');
    expect(result.analysis).toContain('[out.json](https://agentweb-user-files');
  });

  test('captures multiple generated files in one stdout block', async () => {
    mockedUploadFileToS3
      .mockResolvedValueOnce({ success: true, url: 'https://agentweb-user-files.s3.amazonaws.com/a.csv', key: 'a.csv' })
      .mockResolvedValueOnce({ success: true, url: 'https://agentweb-user-files.s3.amazonaws.com/b.csv', key: 'b.csv' });

    const stdout = `<<<AGENTWEB_FILE:a.csv>>>\nx,y\n1,2\n<<<AGENTWEB_FILE_END>>>\n<<<AGENTWEB_FILE:b.csv>>>\np,q\n3,4\n<<<AGENTWEB_FILE_END>>>`;

    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [{ content: { parts: [{ codeExecutionResult: { output: stdout } }] } }]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Save two files.', 'user-1');

    expect(mockedUploadFileToS3).toHaveBeenCalledTimes(2);
    expect(result.fileUrls).toHaveLength(2);
    expect(result.analysis).toContain('a.csv');
    expect(result.analysis).toContain('b.csv');
  });

  test('reports upload failure for a generated file without failing the whole analysis', async () => {
    mockedUploadFileToS3.mockResolvedValueOnce({ success: false, error: 'S3 down' });

    const stdout = `<<<AGENTWEB_FILE:seed.csv>>>\na,b\n1,2\n<<<AGENTWEB_FILE_END>>>`;
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Analysis text.' }, { codeExecutionResult: { output: stdout } }] } }] }
    });

    const result = await (service as any).performDataAnalysis([], 'Save seed.csv.', 'user-1');

    expect(result.success).toBe(true);
    expect(result.fileUrls).toBeUndefined();
    expect(result.analysis).toContain('**Analysis:** Analysis text.');
    expect(result.analysis).not.toContain('**Generated Files:**');
  });

  test('falls back to a default filename when the marker filename is empty', async () => {
    mockedUploadFileToS3.mockResolvedValueOnce({
      success: true,
      url: 'https://agentweb-user-files.s3.amazonaws.com/analysis_output_0.csv',
      key: 'analysis_output_0.csv'
    });

    const stdout = `<<<AGENTWEB_FILE:>>>\na,b\n1,2\n<<<AGENTWEB_FILE_END>>>`;
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ codeExecutionResult: { output: stdout } }] } }] }
    });

    const result = await (service as any).performDataAnalysis([], 'Save a file.', 'user-1');

    expect(mockedUploadFileToS3).toHaveBeenCalledWith(
      expect.any(Buffer),
      'analysis_output_0.csv',
      'user-1',
      'text/csv'
    );
    expect(result.success).toBe(true);
  });

  test('does not call upload when no file markers are present', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Just a plain summary, no files.' }] } }] }
    });

    const result = await (service as any).performDataAnalysis([], 'Summarize only.', 'user-1');

    expect(mockedUploadFileToS3).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.fileUrls).toBeUndefined();
    expect(result.analysis).not.toContain('**Generated Files:**');
  });

  test('defaults to the gemini-3.5-flash model for code execution', async () => {
    delete process.env.DATA_ANALYSIS_LLM_NAME;
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis([], 'Summarize.', 'user-1');

    const apiUrl = mockedAxiosPost.mock.calls[0][0] as string;
    expect(apiUrl).toContain('gemini-3.5-flash');
  });

  test('honors DATA_ANALYSIS_LLM_NAME override when set', async () => {
    process.env.DATA_ANALYSIS_LLM_NAME = 'gemini-3-flash-preview';
    mockedAxiosPost.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: 'Done.' }] } }] }
    });

    await (service as any).performDataAnalysis([], 'Summarize.', 'user-1');

    const apiUrl = mockedAxiosPost.mock.calls[0][0] as string;
    expect(apiUrl).toContain('gemini-3-flash-preview');
    delete process.env.DATA_ANALYSIS_LLM_NAME;
  });

  // ---------------------------------------------------------------------------
  // Regression: response shapes that carry the real analysis in
  // codeExecutionResult.output (no final `text` part). Gemini code-execution
  // models — gemini-3.5-flash especially — intermittently end a turn after the
  // last code block without emitting a summary text part, or pause on an
  // internal functionCall. The old extractor only mined codeExecutionResult
  // output for download markers and never surfaced it as analysis text, so these
  // turns produced zero resultParts and failed with "No analysis results
  // received from Gemini" — the exact failure seen in scheduled session
  // 8aa71237 (perform_data_analysis failed 4x on a ~400KB payload).
  // ---------------------------------------------------------------------------
  test('surfaces codeExecutionResult.output as analysis when there is no text part', async () => {
    const stdout = 'Total tokens: 1234567\nTotal cost: $42.50\nTop session: sess-9 ($5.00)';
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { executableCode: { language: 'PYTHON', code: 'print(report)' } },
                { codeExecutionResult: { outcome: 'OUTCOME_OK', output: stdout } }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Daily token usage & cost report.', 'user-1');

    expect(result.success).toBe(true);
    expect(result.codeExecuted).toBe(true);
    expect(result.analysis).toContain('Total tokens: 1234567');
    expect(result.analysis).toContain('Total cost: $42.50');
  });

  test('surfaces snake_case code_execution_result.output as analysis when there is no text part', async () => {
    const stdout = 'Grand total: 999\nRows processed: 2300';
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { code_execution_result: { outcome: 'OUTCOME_OK', output: stdout } }
              ]
            }
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Compute grand total.', 'user-1');

    expect(result.success).toBe(true);
    expect(result.codeExecuted).toBe(true);
    expect(result.analysis).toContain('Grand total: 999');
  });

  test('still strips download-marker blocks from code-exec output surfaced as analysis', async () => {
    mockedUploadFileToS3.mockResolvedValueOnce({
      success: true,
      url: 'https://agentweb-user-files.s3.amazonaws.com/report.csv',
      key: 'report.csv'
    });
    const stdout = 'Summary line one.\n<<<AGENTWEB_FILE:report.csv>>>\na,b\n1,2\n<<<AGENTWEB_FILE_END>>>\nSummary line two.';
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          { content: { parts: [{ codeExecutionResult: { output: stdout } }] } }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Save report.csv and summarize.', 'user-1');

    expect(result.success).toBe(true);
    // The raw CSV body must not leak into the analysis text.
    expect(result.analysis).not.toContain('a,b\n1,2');
    // The human-readable summary lines around the marker should survive.
    expect(result.analysis).toContain('Summary line one.');
    expect(result.analysis).toContain('Summary line two.');
    // And the download link is still surfaced.
    expect(result.analysis).toContain('**Generated Files:**');
    expect(result.analysis).toContain('report.csv');
  });

  test('returns actionable guidance (not the generic message) when the turn ends on a functionCall with no usable output', async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'run_command', args: { CommandLine: 'head -n 5 input_file_0.csv' } } }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      }
    });

    const result = await (service as any).performDataAnalysis([], 'Analyze the dataset.', 'user-1');

    expect(result.success).toBe(false);
    // Must be actionable + flagged non-retryable, NOT the old opaque string that
    // triggered blind retries.
    expect(result.message).toMatch(/did not return|incomplete|try again|rephrase|simplif/i);
    expect(result.message).not.toBe('No analysis results received from Gemini');
  });
});

describe('perform_data_analysis in DEFAULT_FOUNDATION_TOOLS', () => {
  it('should include perform_data_analysis in DEFAULT_FOUNDATION_TOOLS so scheduled sessions can access it without explicit skill install', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('perform_data_analysis');
  });
});

describe('formatToolError for perform_data_analysis', () => {
  let svc: AgentModeService;

  beforeEach(() => {
    svc = new AgentModeService();
  });

  it('returns timeout-chunking guidance when error message mentions timeout', () => {
    const result = (svc as any).formatToolError('perform_data_analysis', 'timeout of 1200000ms exceeded');
    expect(result).toContain('smaller pieces');
    expect(result).not.toContain('save_file');
  });

  it('returns timeout-chunking guidance when error message says timed out', () => {
    const result = (svc as any).formatToolError('perform_data_analysis', 'The analysis timed out — the dataset or analysis task is too large for a single call.');
    expect(result).toContain('smaller pieces');
  });

  it('returns save_file guidance when error message says too large (payload, not timeout)', () => {
    const result = (svc as any).formatToolError('perform_data_analysis', 'The data payload sent to Gemini was too large.');
    expect(result).toContain('save_file');
  });
});
