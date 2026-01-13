import request from 'supertest';
import express, { Request, Response } from 'express';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';
import { resendService } from '../services/resendService';
import axios from 'axios';

// Mock the dependencies
jest.mock('../services/db');
jest.mock('../services/resendService');
jest.mock('axios');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResendService = resendService as jest.Mocked<typeof resendService>;
const mockAxios = axios as jest.Mocked<typeof axios>;

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-admin', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (req: any, res: any, next: any) => {
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const getRouteHandler = (path: string, method: 'post' | 'get' | 'put' | 'delete') => {
  const layer = (adminRoutes as any).stack.find((item: any) =>
    item.route && item.route.path === path && item.route.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }

  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
};

const mockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

describe('Admin Announcements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock implementations
    // sendSystemEmail internally calls sendEmail with the correct from address
    (mockResendService as any).sendEmail = jest.fn().mockResolvedValue({ id: 'test-email-id' });
    (mockResendService as any).sendSystemEmail = jest.fn().mockImplementation(async (params: any) => {
      // Simulate what sendSystemEmail does: call sendEmail with from field set
      return (mockResendService as any).sendEmail({
        from: 'AgentWeb <no-reply@updates.agentweb.pro>',
        ...params
      });
    });
    (mockUserDb as any).getAllUsers = jest.fn().mockResolvedValue([
      { userId: 'user1', email: 'user1@example.com', isActive: true },
      { userId: 'user2', email: 'user2@example.com', isActive: true },
      { userId: 'user3', email: 'user3@example.com', isActive: false },
    ]);
  });

  describe('POST /api/admin/announcements/send', () => {
    it('should send announcement to all active users using message HTML directly', async () => {
      const title = 'Test Announcement';
      const message = '<p>This is a test message</p>';

      const response = await request(app)
        .post('/api/admin/announcements/send')
        .send({ title, message })
        .expect(200);

      expect(response.body.message).toContain('Announcement sent to');
      expect(response.body.details.total).toBe(2); // Only active users
      expect(response.body.details.successful).toBe(2);

      // Verify resendService.sendSystemEmail was called (which internally calls sendEmail with correct from)
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(2);
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledWith({
        to: 'user1@example.com',
        subject: title,
        text: expect.stringContaining('This is a test message'), // Plain text version
        html: message // HTML version - used directly without wrapper
      });
      // Verify sendEmail was called with correct from address
      expect(mockResendService.sendEmail).toHaveBeenCalledTimes(2);
      expect(mockResendService.sendEmail).toHaveBeenCalledWith({
        from: 'AgentWeb <no-reply@updates.agentweb.pro>',
        to: 'user1@example.com',
        subject: title,
        text: expect.stringContaining('This is a test message'),
        html: message
      });
    });

    it('should return 400 if title is missing', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/send')
        .send({ message: '<p>Test message</p>' })
        .expect(400);

      expect(response.body.message).toBe('Title and message are required');
    });

    it('should return 400 if message is missing', async () => {
      const handler = getRouteHandler('/announcements/send', 'post');
      const req = {
        body: { title: 'Test Title' }
      } as unknown as Request;
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Title and message are required' });
    });

    it('should handle email sending failures gracefully', async () => {
      (mockResendService as any).sendEmail = jest.fn()
        .mockRejectedValueOnce(new Error('Email failed'))
        .mockResolvedValueOnce({ id: 'test-email-id' });
      (mockResendService as any).sendSystemEmail = jest.fn().mockImplementation(async (params: any) => {
        return (mockResendService as any).sendEmail({
          from: 'AgentWeb <no-reply@updates.agentweb.pro>',
          ...params
        });
      });

      const response = await request(app)
        .post('/api/admin/announcements/send')
        .send({ 
          title: 'Test Announcement',
          message: '<p>Test message</p>'
        })
        .expect(200);

      expect(response.body.details.successful).toBe(1);
      expect(response.body.details.failed).toBe(1);
      expect(response.body.details.failedEmails).toContain('user1@example.com');
    });

    it('should handle null return value from resendService (failed after retries)', async () => {
      (mockResendService as any).sendEmail = jest.fn()
        .mockResolvedValueOnce(null) // Failed after retries
        .mockResolvedValueOnce({ id: 'test-email-id' });

      const response = await request(app)
        .post('/api/admin/announcements/send')
        .send({ 
          title: 'Test Announcement',
          message: '<p>Test message</p>'
        })
        .expect(200);

      expect(response.body.details.successful).toBe(1);
      expect(response.body.details.failed).toBe(1);
      expect(response.body.details.failedEmails).toContain('user1@example.com');
    });
  });

  describe('POST /api/admin/announcements/test', () => {
    it('should send test announcement to specified recipients with test banner', async () => {
      const title = 'Test Announcement';
      const message = '<p>This is a test message</p>';
      const recipients = ['test1@example.com', 'test2@example.com'];

      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ title, message, recipients })
        .expect(200);

      expect(response.body.message).toContain('Test announcement sent to');
      expect(response.body.details.total).toBe(2);
      expect(response.body.details.successful).toBe(2);

      // Verify resendService.sendSystemEmail was called (which internally calls sendEmail with correct from)
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(2);
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledWith({
        to: 'test1@example.com',
        subject: '[TEST] Test Announcement',
        text: expect.stringContaining('This is a test message'), // Plain text version
        html: expect.stringContaining('🧪 TEST EMAIL - This is a test announcement') // Test banner
      });
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledWith({
        to: 'test2@example.com',
        subject: '[TEST] Test Announcement',
        text: expect.any(String),
        html: expect.stringMatching(/<div style="background-color: #ff9800.*TEST EMAIL.*<\/div>.*<p>This is a test message<\/p>/s)
      });
      // Verify sendEmail was called with correct from address
      expect(mockResendService.sendEmail).toHaveBeenCalledTimes(2);
      expect(mockResendService.sendEmail).toHaveBeenCalledWith({
        from: 'AgentWeb <no-reply@updates.agentweb.pro>',
        to: 'test1@example.com',
        subject: '[TEST] Test Announcement',
        text: expect.stringContaining('This is a test message'),
        html: expect.stringContaining('🧪 TEST EMAIL - This is a test announcement')
      });
    });

    it('should return 400 if title is missing', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          message: '<p>Test message</p>',
          recipients: ['test@example.com']
        })
        .expect(400);

      expect(response.body.message).toBe('Title and message are required');
    });

    it('should return 400 if message is missing', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Title',
          recipients: ['test@example.com']
        })
        .expect(400);

      expect(response.body.message).toBe('Title and message are required');
    });

    it('should return 400 if recipients array is missing', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Title',
          message: '<p>Test message</p>'
        })
        .expect(400);

      expect(response.body.message).toBe('At least one recipient email is required');
    });

    it('should return 400 if recipients array is empty', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Title',
          message: '<p>Test message</p>',
          recipients: []
        })
        .expect(400);

      expect(response.body.message).toBe('At least one recipient email is required');
    });

    it('should filter out invalid email addresses', async () => {
      const title = 'Test Announcement';
      const message = '<p>Test message</p>';
      const recipients = ['valid@example.com', 'invalid-email', 'another@example.com'];

      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ title, message, recipients })
        .expect(200);

      expect(response.body.details.total).toBe(2); // Only valid emails
      expect(response.body.details.invalidEmails).toContain('invalid-email');
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledTimes(2);
      expect(mockResendService.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('should return 400 if no valid email addresses provided', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Title',
          message: '<p>Test message</p>',
          recipients: ['invalid-email', 'also-invalid']
        })
        .expect(400);

      expect(response.body.message).toBe('No valid email addresses provided');
    });

    it('should trim email addresses before validation', async () => {
      const title = 'Test Announcement';
      const message = '<p>Test message</p>';
      const recipients = ['  valid@example.com  ', '  another@example.com  '];

      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ title, message, recipients })
        .expect(200);

      expect(response.body.details.total).toBe(2);
      expect(mockResendService.sendSystemEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'valid@example.com', // Trimmed
          subject: expect.any(String),
          text: expect.any(String),
          html: expect.any(String)
        })
      );
      expect(mockResendService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'AgentWeb <no-reply@updates.agentweb.pro>',
          to: 'valid@example.com', // Trimmed
          subject: expect.any(String),
          text: expect.any(String),
          html: expect.any(String)
        })
      );
    });

    it('should handle email sending failures and track failed emails', async () => {
      (mockResendService as any).sendEmail = jest.fn()
        .mockRejectedValueOnce(new Error('Email failed'))
        .mockResolvedValueOnce({ id: 'test-email-id' });
      (mockResendService as any).sendSystemEmail = jest.fn().mockImplementation(async (params: any) => {
        return (mockResendService as any).sendEmail({
          from: 'AgentWeb <no-reply@updates.agentweb.pro>',
          ...params
        });
      });

      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Announcement',
          message: '<p>Test message</p>',
          recipients: ['test1@example.com', 'test2@example.com']
        })
        .expect(200);

      expect(response.body.details.successful).toBe(1);
      expect(response.body.details.failed).toBe(1);
      expect(response.body.details.failedEmails).toContain('test1@example.com');
    });

    it('should handle null return value from resendService (failed after retries)', async () => {
      (mockResendService as any).sendEmail = jest.fn()
        .mockResolvedValueOnce(null) // Failed after retries
        .mockResolvedValueOnce({ id: 'test-email-id' });

      const response = await request(app)
        .post('/api/admin/announcements/test')
        .send({ 
          title: 'Test Announcement',
          message: '<p>Test message</p>',
          recipients: ['test1@example.com', 'test2@example.com']
        })
        .expect(200);

      expect(response.body.details.successful).toBe(1);
      expect(response.body.details.failed).toBe(1);
      expect(response.body.details.failedEmails).toContain('test1@example.com');
    });
  });

  describe('POST /api/admin/announcements/load-from-url', () => {
    it('should load HTML content from URL and extract title and message', async () => {
      const mockHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Page Title</title>
          </head>
          <body>
            <main>
              <h1>Main Content</h1>
              <p>This is the body content</p>
            </main>
          </body>
        </html>
      `;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml,
        headers: { 'content-type': 'text/html' }
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.title).toBe('Test Page Title');
      expect(response.body.message).toContain('Main Content');
      expect(response.body.message).toContain('This is the body content');
      expect(mockAxios.get).toHaveBeenCalledWith(
        'https://example.com/page.html',
        expect.objectContaining({
          timeout: 15000,
          responseType: 'text',
          headers: expect.objectContaining({
            'User-Agent': 'AgentWeb-Backend/1.0'
          })
        })
      );
    });

    it('should extract title from h1 if title tag is missing', async () => {
      const mockHtml = `
        <html>
          <body>
            <h1>H1 Title</h1>
            <p>Content here</p>
          </body>
        </html>
      `;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.title).toBe('H1 Title');
    });

    it('should use default title if neither title nor h1 found', async () => {
      const mockHtml = '<html><body><p>Content only</p></body></html>';

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.title).toBe('Announcement');
    });

    it('should remove script and style tags from content', async () => {
      const mockHtml = `
        <html>
          <body>
            <script>alert('test');</script>
            <style>.test { color: red; }</style>
            <p>Actual content</p>
          </body>
        </html>
      `;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.message).not.toContain('alert');
      expect(response.body.message).not.toContain('.test { color: red; }');
      expect(response.body.message).toContain('Actual content');
    });

    it('should extract content from main or article tags when available', async () => {
      const mockHtml = `
        <html>
          <body>
            <div>Other content</div>
            <main>
              <p>Main content here</p>
            </main>
            <div>More other content</div>
          </body>
        </html>
      `;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.message).toContain('Main content here');
    });

    it('should return 400 if URL is missing', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({})
        .expect(400);

      expect(response.body.message).toBe('URL is required and must be a string');
    });

    it('should return 400 if URL is not a string', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 123 })
        .expect(400);

      expect(response.body.message).toBe('URL is required and must be a string');
    });

    it('should return 400 if URL is not HTTP/HTTPS', async () => {
      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'ftp://example.com/file.html' })
        .expect(400);

      expect(response.body.message).toBe('Invalid URL format. Must be HTTP or HTTPS.');
    });

    it('should handle HTTP errors from axios', async () => {
      (mockAxios.get as jest.Mock).mockRejectedValueOnce({
        response: {
          status: 404,
          statusText: 'Not Found'
        }
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/notfound.html' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('HTTP 404');
    });

    it('should handle network errors', async () => {
      (mockAxios.get as jest.Mock).mockRejectedValueOnce({
        code: 'ENOTFOUND',
        message: 'DNS lookup failed'
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://nonexistent.example.com/page.html' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('URL not found or unreachable');
    });

    it('should handle timeout errors', async () => {
      (mockAxios.get as jest.Mock).mockRejectedValueOnce({
        code: 'ETIMEDOUT',
        message: 'Request timeout'
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/slow.html' })
        .expect(408);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Request timeout while fetching HTML');
    });

    it('should handle connection refused errors', async () => {
      (mockAxios.get as jest.Mock).mockRejectedValueOnce({
        code: 'ECONNREFUSED',
        message: 'Connection refused'
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(503);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Connection refused');
    });

    it('should decode HTML entities in title', async () => {
      const mockHtml = `
        <html>
          <head>
            <title>Test &amp; Title &lt;Special&gt;</title>
          </head>
          <body>
            <p>Content</p>
          </body>
        </html>
      `;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.title).toBe('Test & Title <Special>');
    });

    it('should limit content length to 50KB', async () => {
      const longContent = '<p>' + 'x'.repeat(60000) + '</p>';
      const mockHtml = `<html><body>${longContent}</body></html>`;

      (mockAxios.get as jest.Mock).mockResolvedValueOnce({
        data: mockHtml
      });

      const response = await request(app)
        .post('/api/admin/announcements/load-from-url')
        .send({ url: 'https://example.com/page.html' })
        .expect(200);

      expect(response.body.message.length).toBeLessThanOrEqual(50003); // 50000 + "..."
      expect(response.body.message).toContain('...');
    });
  });
});
