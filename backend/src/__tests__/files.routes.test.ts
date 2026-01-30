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

import request from 'supertest';
import express from 'express';
import axios from 'axios';
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

    it('should reject non-allowlisted domains', async () => {
      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`)
        .query({ url: 'https://example.com/file.html' });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('success', false);
      expect(response.body.message).toContain('not in allowlist');
    });

    it('should accept allowlisted S3 bucket URLs', async () => {
      // Mock successful axios response
      mockedAxios.get.mockResolvedValueOnce({
        data: '<html><body>Test content</body></html>',
        headers: { 'content-type': 'text/html' },
      } as any);

      const response = await request(app)
        .get('/api/files/content')
        .set('Authorization', `Bearer ${validToken}`)
        .query({ url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/test.html' });

      // Should pass validation and return success
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('content');
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
