import request from 'supertest';
import express from 'express';
import taskRoutes from '../routes/tasks';

// Mock the database services
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
  },
  subscriberDb: {
    addSubscriber: jest.fn(),
    getTaskSubscriberByEmail: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

// Mock email service
jest.mock('../services/emailService', () => ({
  emailService: {
    sendSubscriberWelcomeEmail: jest.fn(),
  },
}));

// Mock resend service
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

import { taskDb, subscriberDb, userDb } from '../services/db';
import { emailService } from '../services/emailService';

describe('Subscriber Join Endpoint', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tasks', taskRoutes);
    jest.clearAllMocks();
  });

  describe('POST /api/tasks/:taskId/subscribers/join', () => {
    const taskId = 'test-task-123';
    const email = 'test@example.com';

    it('should successfully add subscriber and send welcome email', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: 'Test Task',
        emailSender: null,
        fromName: null,
      };

      const mockUser = {
        userId: 'user-123',
        emailDomain: null,
        defaultSenderUsername: null,
        fromName: null,
      };

      const mockSubscriber = {
        taskId,
        email,
        subscribedAt: new Date().toISOString(),
        unsubscribed: false,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (subscriberDb.addSubscriber as jest.Mock).mockResolvedValue(mockSubscriber);
      (emailService.sendSubscriberWelcomeEmail as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({ email })
        .set('Origin', 'https://example.com')
        .expect(201);

      expect(response.body).toMatchObject({
        taskId,
        email,
        unsubscribed: false,
      });

      expect(subscriberDb.addSubscriber).toHaveBeenCalledWith(taskId, email);
      expect(emailService.sendSubscriberWelcomeEmail).toHaveBeenCalledWith(email, taskId);
    });

    it('should return 400 if email is missing', async () => {
      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({})
        .set('Origin', 'https://example.com')
        .expect(400);

      expect(response.body.message).toBe('Email is required');
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('should return 400 if email format is invalid', async () => {
      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({ email: 'invalid-email' })
        .set('Origin', 'https://example.com')
        .expect(400);

      expect(response.body.message).toBe('Invalid email format');
      expect(subscriberDb.addSubscriber).not.toHaveBeenCalled();
    });

    it('should return 409 if email already exists', async () => {
      const error = new Error(`Email ${email} is already in the subscriber list for this task`);
      
      (subscriberDb.addSubscriber as jest.Mock).mockRejectedValue(error);

      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({ email })
        .set('Origin', 'https://example.com')
        .expect(409);

      expect(response.body.message).toContain('already in the subscriber list');
    });

    it('should allow requests from any origin (CORS)', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: 'Test Task',
      };

      const mockUser = {
        userId: 'user-123',
      };

      const mockSubscriber = {
        taskId,
        email,
        subscribedAt: new Date().toISOString(),
        unsubscribed: false,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (subscriberDb.addSubscriber as jest.Mock).mockResolvedValue(mockSubscriber);
      (emailService.sendSubscriberWelcomeEmail as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({ email })
        .set('Origin', 'https://any-external-site.com')
        .expect(201);

      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.body).toMatchObject({ taskId, email });
    });

    it('should handle welcome email failure gracefully', async () => {
      const mockTask = {
        taskId,
        userId: 'user-123',
        name: 'Test Task',
      };

      const mockUser = {
        userId: 'user-123',
      };

      const mockSubscriber = {
        taskId,
        email,
        subscribedAt: new Date().toISOString(),
        unsubscribed: false,
      };

      (taskDb.getTaskById as jest.Mock).mockResolvedValue(mockTask);
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (subscriberDb.addSubscriber as jest.Mock).mockResolvedValue(mockSubscriber);
      (emailService.sendSubscriberWelcomeEmail as jest.Mock).mockRejectedValue(new Error('Email send failed'));

      // Should still return 201 even if email fails
      const response = await request(app)
        .post(`/api/tasks/${taskId}/subscribers/join`)
        .send({ email })
        .set('Origin', 'https://example.com')
        .expect(201);

      expect(response.body).toMatchObject({ taskId, email });
      expect(subscriberDb.addSubscriber).toHaveBeenCalled();
    });
  });
});

