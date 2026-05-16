import { AgentModeService } from '../services/agentModeService';
import { DynamoDB } from 'aws-sdk';
import axios from 'axios';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: {
    update: jest.fn()
  }
}));

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn()
}));

// Mock crypto
jest.mock('crypto', () => ({
  createHash: jest.fn()
}));

// Mock pdf-parse
jest.mock('pdf-parse', () => jest.fn());

// Mock xlsx
jest.mock('xlsx', () => ({
  read: jest.fn(),
  utils: {
    sheet_to_csv: jest.fn(),
  },
}));

// Mock s3Utils
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  uploadFileToS3WithPath: jest.fn(),
  uploadScreenshotToS3: jest.fn(),
  getS3ObjectAsString: jest.fn(),
}));

describe('readFileContent', () => {
  let agentModeService: AgentModeService;
  let mockDynamoDB: jest.Mocked<DynamoDB>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockDynamoDB = {
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    } as any;

    agentModeService = new AgentModeService();
    (agentModeService as any).dynamoDB = mockDynamoDB;

    // Setup crypto mock
    const mockHash = {
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('test-hash-123')
    };
    const { createHash } = require('crypto');
    createHash.mockReturnValue(mockHash);

    // Setup pdf-parse mock
    const pdfParse = require('pdf-parse');
    pdfParse.mockResolvedValue({ text: 'Test PDF content' });
  });

  describe('content hash generation', () => {
    it('should generate content hash for text files', async () => {
      const testContent = '<html><body>Test content</body></html>';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/html' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.html');

      expect(result.success).toBe(true);
      expect(result.content).toBe(testContent);
      expect(result.content_hash).toBe('test-hash-123');
      const { createHash } = require('crypto');
      expect(createHash).toHaveBeenCalledWith('sha256');
    });

    it('should generate content hash for PDF files', async () => {
      const testContent = 'PDF text content';
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      // Mock pdf-parse
      const pdfParse = require('pdf-parse');
      pdfParse.mockResolvedValue({ text: testContent });

      const result = await (agentModeService as any).readFileContent('https://example.com/file.pdf');

      expect(result.success).toBe(true);
      expect(result.content).toBe(testContent);
      expect(result.content_hash).toBe('test-hash-123');
      expect(result.file_type).toBe('pdf');
    });

    it('should generate content hash for CSV files', async () => {
      const testContent = 'name,age\nJohn,30\nJane,25';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/csv' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.csv');

      expect(result.success).toBe(true);
      expect(result.content).toBe(testContent);
      expect(result.content_hash).toBe('test-hash-123');
      expect(result.file_type).toBe('text');
    });

    it('should generate content hash for JSON files', async () => {
      const testContent = '{"name": "John", "age": 30}';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'application/json' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.json');

      expect(result.success).toBe(true);
      expect(result.content).toBe(testContent);
      expect(result.content_hash).toBe('test-hash-123');
      expect(result.file_type).toBe('text');
    });
  });

  describe('hash consistency', () => {
    it('should generate same hash for identical content', async () => {
      const testContent = 'Identical content';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/plain' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      // Mock hash to return same value for same input
      const mockHash = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('consistent-hash-123')
      };
      const { createHash } = require('crypto');
      createHash.mockReturnValue(mockHash as any);

      const result1 = await (agentModeService as any).readFileContent('https://example.com/file1.txt');
      const result2 = await (agentModeService as any).readFileContent('https://example.com/file2.txt');

      expect(result1.content_hash).toBe('consistent-hash-123');
      expect(result2.content_hash).toBe('consistent-hash-123');
      expect(result1.content_hash).toBe(result2.content_hash);
    });

    it('should generate different hash for different content', async () => {
      const testContent1 = 'Content 1';
      const testContent2 = 'Content 2';
      
      const mockResponse1 = {
        data: Buffer.from(testContent1),
        headers: { 'content-type': 'text/plain' }
      };
      const mockResponse2 = {
        data: Buffer.from(testContent2),
        headers: { 'content-type': 'text/plain' }
      };

      // Mock hash to return different values for different inputs
      let callCount = 0;
      const mockHash = {
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockImplementation(() => {
          callCount++;
          return `hash-${callCount}`;
        })
      };
      const { createHash } = require('crypto');
      createHash.mockReturnValue(mockHash as any);

      const axios = require('axios');
      axios.get
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);

      const result1 = await (agentModeService as any).readFileContent('https://example.com/file1.txt');
      const result2 = await (agentModeService as any).readFileContent('https://example.com/file2.txt');

      expect(result1.content_hash).toBe('hash-1');
      expect(result2.content_hash).toBe('hash-2');
      expect(result1.content_hash).not.toBe(result2.content_hash);
    });
  });

  describe('error handling', () => {
    it('should handle network errors gracefully', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await (agentModeService as any).readFileContent('https://example.com/file.html');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to read file content');
    });

    it('should handle invalid URL format', async () => {
      const result = await (agentModeService as any).readFileContent('invalid-url');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid URL format. Must be HTTP or HTTPS.');
    });

    it('should handle PDF parsing errors', async () => {
      const mockResponse = {
        data: Buffer.from('corrupted pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      // Mock pdf-parse to throw error
      const pdfParse = require('pdf-parse');
      pdfParse.mockRejectedValue(new Error('PDF parsing failed'));

      const result = await (agentModeService as any).readFileContent('https://example.com/file.pdf');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse PDF file');
    });

    it('should save large content to S3 and return extracted_content_url', async () => {
      const largeContent = 'x'.repeat(60000); // Exceeds 50KB inline limit
      const mockResponse = {
        data: Buffer.from(largeContent),
        headers: { 'content-type': 'text/plain' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const { uploadFileToS3 } = require('../utils/s3Utils');
      uploadFileToS3.mockResolvedValue({ success: true, url: 'https://s3.example.com/extracted.txt' });

      const result = await (agentModeService as any).readFileContent('https://example.com/large-file.txt');

      expect(result.success).toBe(true);
      expect(result.extracted_content_url).toBe('https://s3.example.com/extracted.txt');
      expect(result.content).toContain('perform_data_analysis');
      expect(result.content).toContain('https://s3.example.com/extracted.txt');
      expect(uploadFileToS3).toHaveBeenCalled();
    });

    it('should fall back to truncation when S3 upload fails', async () => {
      const largeContent = 'y'.repeat(60000);
      const mockResponse = {
        data: Buffer.from(largeContent),
        headers: { 'content-type': 'text/plain' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const { uploadFileToS3 } = require('../utils/s3Utils');
      uploadFileToS3.mockResolvedValue({ success: false });

      const result = await (agentModeService as any).readFileContent('https://example.com/large-file.txt');

      expect(result.success).toBe(true);
      expect(result.content).toContain('[Content truncated due to size limit]');
      expect(result.extracted_content_url).toBeUndefined();
    });
  });

  describe('file type detection', () => {
    it('should detect HTML files by extension', async () => {
      const testContent = '<html><body>Test</body></html>';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/html' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.html');

      expect(result.success).toBe(true);
      expect(result.file_type).toBe('text');
    });

    it('should detect Markdown files by extension', async () => {
      const testContent = '# Test Markdown';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/markdown' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.md');

      expect(result.success).toBe(true);
      expect(result.file_type).toBe('text');
    });

    it('should detect unknown file types', async () => {
      const testContent = 'Some binary content';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'application/octet-stream' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.xyz');

      expect(result.success).toBe(true);
      expect(result.file_type).toBe('text');
    });
  });

  describe('response format', () => {
    it('should return all required fields', async () => {
      const testContent = 'Test content';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/plain' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.txt');

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('content', testContent);
      expect(result).toHaveProperty('content_hash', 'test-hash-123');
      expect(result).toHaveProperty('file_type', 'text');
      expect(result).toHaveProperty('file_size', testContent.length);
      expect(result).toHaveProperty('content_length', testContent.length);
      expect(result).toHaveProperty('file_url', 'https://example.com/file.txt');
      expect(result).toHaveProperty('message');
    });

    it('should include proper metadata', async () => {
      const testContent = 'Test content';
      const mockResponse = {
        data: Buffer.from(testContent),
        headers: { 'content-type': 'text/plain' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/file.txt');

      expect(result.file_size).toBe(testContent.length);
      expect(result.content_length).toBe(testContent.length);
      expect(result.file_url).toBe('https://example.com/file.txt');
      expect(result.message).toContain('Successfully read text file content');
    });
  });

  describe('XLSX / Excel file parsing', () => {
    beforeEach(() => {
      const XLSX = require('xlsx');
      XLSX.read.mockReturnValue({
        SheetNames: ['Sheet1'],
        Sheets: { Sheet1: {} },
      });
      XLSX.utils.sheet_to_csv.mockReturnValue('Campaign,Impressions,Clicks\nPost A,10000,500\nPost B,8000,320');
    });

    it('should parse an XLSX file and return CSV content', async () => {
      const mockResponse = {
        data: Buffer.from('fake xlsx binary'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/report.xlsx');

      expect(result.success).toBe(true);
      expect(result.file_type).toBe('spreadsheet');
      expect(result.content).toContain('Sheet: Sheet1');
      expect(result.content).toContain('Campaign,Impressions,Clicks');
      expect(result.content).toContain('Post A,10000,500');
    });

    it('should detect xlsx by file extension regardless of content-type', async () => {
      const mockResponse = {
        data: Buffer.from('fake xlsx binary'),
        headers: { 'content-type': 'application/octet-stream' },
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://s3.amazonaws.com/bucket/PostAnalytics.xlsx');

      expect(result.success).toBe(true);
      expect(result.file_type).toBe('spreadsheet');
    });

    it('should handle multi-sheet XLSX and label each sheet', async () => {
      const XLSX = require('xlsx');
      XLSX.read.mockReturnValue({
        SheetNames: ['Overview', 'Details'],
        Sheets: { Overview: {}, Details: {} },
      });
      XLSX.utils.sheet_to_csv
        .mockReturnValueOnce('Metric,Value\nTotal,100')
        .mockReturnValueOnce('Date,Post,Clicks\n2024-01,Post A,50');

      const mockResponse = {
        data: Buffer.from('fake xlsx binary'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/multi.xlsx');

      expect(result.success).toBe(true);
      expect(result.content).toContain('Sheet: Overview');
      expect(result.content).toContain('Sheet: Details');
      expect(result.content).toContain('Metric,Value');
      expect(result.content).toContain('Date,Post,Clicks');
    });

    it('should skip blank sheets and only include sheets with content', async () => {
      const XLSX = require('xlsx');
      XLSX.read.mockReturnValue({
        SheetNames: ['Data', 'Empty'],
        Sheets: { Data: {}, Empty: {} },
      });
      XLSX.utils.sheet_to_csv
        .mockReturnValueOnce('Col1,Col2\nA,B')
        .mockReturnValueOnce('');

      const mockResponse = {
        data: Buffer.from('fake xlsx binary'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/sparse.xlsx');

      expect(result.success).toBe(true);
      expect(result.content).toContain('Sheet: Data');
      expect(result.content).not.toContain('Sheet: Empty');
    });

    it('should return error when XLSX parsing fails', async () => {
      const XLSX = require('xlsx');
      XLSX.read.mockImplementation(() => { throw new Error('Corrupted workbook'); });

      const mockResponse = {
        data: Buffer.from('garbage'),
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);

      const result = await (agentModeService as any).readFileContent('https://example.com/bad.xlsx');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse Excel file');
    });
  });

  describe('PDF position-aware rendering (pdfPageRender)', () => {
    it('should pass a pagerender function to pdf-parse so table numbers are not concatenated', async () => {
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);
      const pdfParse = require('pdf-parse');
      pdfParse.mockResolvedValue({ text: 'some content' });

      await (agentModeService as any).readFileContent('https://example.com/report.pdf');

      expect(pdfParse).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ pagerender: expect.any(Function) })
      );
    });

    it('pagerender: items on same row (within Y tolerance) should be space-separated, not concatenated', async () => {
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);
      const pdfParse = require('pdf-parse');

      let capturedPageRender: ((pageData: any) => Promise<string>) | undefined;
      pdfParse.mockImplementation((_buf: any, opts: any) => {
        capturedPageRender = opts?.pagerender;
        return Promise.resolve({ text: 'irrelevant' });
      });

      await (agentModeService as any).readFileContent('https://example.com/report.pdf');
      expect(capturedPageRender).toBeDefined();

      // Simulate a PDF table row: three numbers at the same Y, stored left-to-right
      const mockPageData = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            { str: '1,234', transform: [1, 0, 0, 1, 50, 100] },   // x=50
            { str: '5.6%',  transform: [1, 0, 0, 1, 200, 100] },  // x=200 same Y
            { str: '3.2',   transform: [1, 0, 0, 1, 350, 100] },  // x=350 same Y
          ]
        })
      };

      const rendered = await capturedPageRender!(mockPageData);
      // Items should be space-separated, not run together
      expect(rendered).toBe('1,234 5.6% 3.2');
    });

    it('pagerender: items with Y difference beyond tolerance should be on separate lines', async () => {
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);
      const pdfParse = require('pdf-parse');

      let capturedPageRender: ((pageData: any) => Promise<string>) | undefined;
      pdfParse.mockImplementation((_buf: any, opts: any) => {
        capturedPageRender = opts?.pagerender;
        return Promise.resolve({ text: 'irrelevant' });
      });

      await (agentModeService as any).readFileContent('https://example.com/report.pdf');
      expect(capturedPageRender).toBeDefined();

      // Two rows with Y difference > tolerance
      const mockPageData = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            { str: 'Row1Col1', transform: [1, 0, 0, 1, 50, 200] },
            { str: 'Row1Col2', transform: [1, 0, 0, 1, 200, 200] },
            { str: 'Row2Col1', transform: [1, 0, 0, 1, 50, 180] }, // Y=180, different row
            { str: 'Row2Col2', transform: [1, 0, 0, 1, 200, 180] },
          ]
        })
      };

      const rendered = await capturedPageRender!(mockPageData);
      const lines = rendered.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('Row1Col1 Row1Col2');
      expect(lines[1]).toBe('Row2Col1 Row2Col2');
    });

    it('pagerender: items stored out of left-to-right order should be sorted correctly', async () => {
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);
      const pdfParse = require('pdf-parse');

      let capturedPageRender: ((pageData: any) => Promise<string>) | undefined;
      pdfParse.mockImplementation((_buf: any, opts: any) => {
        capturedPageRender = opts?.pagerender;
        return Promise.resolve({ text: 'irrelevant' });
      });

      await (agentModeService as any).readFileContent('https://example.com/report.pdf');
      expect(capturedPageRender).toBeDefined();

      // PDF stores items right-to-left (common in multi-column layouts)
      const mockPageData = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            { str: 'Third',  transform: [1, 0, 0, 1, 400, 100] }, // rightmost, stored first
            { str: 'First',  transform: [1, 0, 0, 1, 50, 100] },  // leftmost, stored second
            { str: 'Second', transform: [1, 0, 0, 1, 200, 100] }, // middle, stored last
          ]
        })
      };

      const rendered = await capturedPageRender!(mockPageData);
      expect(rendered).toBe('First Second Third');
    });

    it('pagerender: empty page should return empty string', async () => {
      const mockResponse = {
        data: Buffer.from('fake pdf data'),
        headers: { 'content-type': 'application/pdf' }
      };
      const axios = require('axios');
      axios.get.mockResolvedValue(mockResponse);
      const pdfParse = require('pdf-parse');

      let capturedPageRender: ((pageData: any) => Promise<string>) | undefined;
      pdfParse.mockImplementation((_buf: any, opts: any) => {
        capturedPageRender = opts?.pagerender;
        return Promise.resolve({ text: '' });
      });

      await (agentModeService as any).readFileContent('https://example.com/report.pdf');
      expect(capturedPageRender).toBeDefined();

      const mockPageData = {
        getTextContent: jest.fn().mockResolvedValue({ items: [] })
      };

      const rendered = await capturedPageRender!(mockPageData);
      expect(rendered).toBe('');
    });
  });
});
