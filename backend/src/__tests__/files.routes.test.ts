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

// Mock S3 utils for getFileContent which now reads directly via SDK
const mockGetS3ObjectStream = jest.fn();
const mockGetS3ObjectMetadata = jest.fn();
jest.mock('../utils/s3Utils', () => {
  const actual = jest.requireActual('../utils/s3Utils');
  return {
    ...actual,
    getS3ObjectStream: (...args: any[]) => mockGetS3ObjectStream(...args),
    getS3ObjectMetadata: (...args: any[]) => mockGetS3ObjectMetadata(...args),
  };
});

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
});
