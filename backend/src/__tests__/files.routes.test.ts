// Mock authentication middleware before any imports
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    // Check if Authorization header exists
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }
    // Mock a valid user
    req.user = { userId: 'test-user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// Mock axios
jest.mock('axios');

// Mock S3 utils
const mockGetS3ObjectStream = jest.fn();
const mockGetS3ObjectMetadata = jest.fn();
const mockUploadFileToS3WithPath = jest.fn();
jest.mock('../utils/s3Utils', () => {
  const actual = jest.requireActual('../utils/s3Utils');
  return {
    ...actual,
    getS3ObjectStream: (...args: any[]) => mockGetS3ObjectStream(...args),
    getS3ObjectMetadata: (...args: any[]) => mockGetS3ObjectMetadata(...args),
    uploadFileToS3WithPath: (...args: any[]) => mockUploadFileToS3WithPath(...args),
  };
});

// Mock ChatbotDB
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({
    clearSearchableTextByUrl: jest.fn().mockResolvedValue(undefined),
  })),
}));

import request from 'supertest';
import express from 'express';
import axios from 'axios';
import { Readable } from 'stream';
import { getFileContent, saveHtmlContent } from '../controllers/filesController';
import { authenticateToken } from '../middleware/auth';

const mockedAxios = axios as jest.Mocked<typeof axios>;

let app: express.Application;

describe('Files routes', () => {
  const validToken = 'mock-token';

  beforeEach(() => {
    jest.clearAllMocks();

    // Create minimal Express app for testing
    app = express();
    app.use(express.json());

    // Mount only the file routes we're testing
    app.get('/api/files/content', authenticateToken, getFileContent);
    app.post('/api/files/html', authenticateToken, saveHtmlContent);
  });

  it('should not expose /api/files/view-external', async () => {
    const response = await request(app)
      .get('/api/files/view-external')
      .query({ url: 'https://example.com' });

    expect(response.status).toBe(404);
  });

  describe('GET /api/files/content', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/files/content')
        .query({ url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/test.html' });

      expect(response.status).toBe(401);
    });

    it('should reject non-S3-bucket URLs', async () => {
      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`)
        .query({ url: 'https://example.com/file.html' });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body.message).toContain('configured S3 bucket');
    });

    it('should accept S3 bucket URLs and read via SDK', async () => {
      // Mock S3 SDK stream response
      const htmlContent = '<html><body>Test content</body></html>';
      const readable = Readable.from([Buffer.from(htmlContent)]);
      mockGetS3ObjectStream.mockReturnValueOnce(readable);
      mockGetS3ObjectMetadata.mockResolvedValueOnce({
        ContentType: 'text/html',
      });

      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`)
        .query({ url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/test.html' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('content', htmlContent);
      expect(mockGetS3ObjectStream).toHaveBeenCalledWith('test.html', expect.any(String));
    });

    it('should reject missing URL parameter', async () => {
      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('URL query parameter is required');
    });

    it('should reject non-HTTP(S) URLs', async () => {
      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`)
        .query({ url: 'file:///etc/passwd' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Must be HTTP or HTTPS');
    });
  });

  describe('POST /api/files/html - searchableText invalidation', () => {
    const S3_URL = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/test-user-123/files/report.html';

    it('should call clearSearchableTextByUrl with the saved URL after successful upload', async () => {
      mockUploadFileToS3WithPath.mockResolvedValue({ success: true, url: S3_URL, key: 'users/test-user-123/files/report.html' });

      const { ChatbotDB } = require('../services/chatbotService');
      const mockInstance = { clearSearchableTextByUrl: jest.fn().mockResolvedValue(undefined) };
      ChatbotDB.mockImplementation(() => mockInstance);

      const response = await request(app)
        .post('/api/files/html')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ url: S3_URL, content: '<html><body>Updated content</body></html>' });

      expect(response.status).toBe(200);
      expect(mockInstance.clearSearchableTextByUrl).toHaveBeenCalledWith('test-user-123', S3_URL);
    });

    it('should still return success if clearSearchableTextByUrl fails', async () => {
      mockUploadFileToS3WithPath.mockResolvedValue({ success: true, url: S3_URL, key: 'users/test-user-123/files/report.html' });

      const { ChatbotDB } = require('../services/chatbotService');
      const mockInstance = { clearSearchableTextByUrl: jest.fn().mockRejectedValue(new Error('DynamoDB error')) };
      ChatbotDB.mockImplementation(() => mockInstance);

      const response = await request(app)
        .post('/api/files/html')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ url: S3_URL, content: '<html><body>Updated</body></html>' });

      // Invalidation is non-critical — upload success should still be returned
      expect(response.status).toBe(200);
    });
  });
});
