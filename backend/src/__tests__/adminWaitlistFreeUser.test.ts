import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';

// Mock the dependencies
jest.mock('../services/db');
jest.mock('../services/emailService');
jest.mock('../services/waitlistDb');
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-admin', isAdmin: true };
    next();
  },
  isAdmin: (req: any, res: any, next: any) => {
    next();
  }
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;

// Set up mock implementations
(mockWaitlistDb as any).updateStatus = jest.fn().mockResolvedValue(undefined);
(mockWaitlistDb as any).getByEmail = jest.fn().mockResolvedValue(undefined);
(mockWaitlistDb as any).add = jest.fn().mockResolvedValue({ email: 'test@example.com', joinedAt: new Date().toISOString() });
(mockWaitlistDb as any).list = jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null });
(mockWaitlistDb as any).updateSupportNote = jest.fn().mockResolvedValue(undefined);
(mockWaitlistDb as any).updateDetails = jest.fn().mockResolvedValue(undefined);
(mockWaitlistDb as any).deleteByEmail = jest.fn().mockResolvedValue(undefined);
(mockUserDb as any).createUser = jest.fn().mockResolvedValue(undefined);
(mockUserDb as any).getUserById = jest.fn().mockResolvedValue({
  userId: 'test-admin',
  email: 'admin@test.com',
  isAdmin: true
});
(mockEmailService as any).sendWelcomeEmail = jest.fn().mockResolvedValue(undefined);
(mockEmailService as any).sendInvitation = jest.fn().mockResolvedValue(undefined);
(mockEmailService as any).sendEmail = jest.fn().mockResolvedValue(undefined);


const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// Add a simple test route to verify the app is working
app.get('/test', (req, res) => {
  res.json({ message: 'Test route working' });
});

describe('Admin Waitlist Free User Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock email service
    mockEmailService.sendWelcomeEmail.mockResolvedValue(undefined);
    mockEmailService.sendInvitation.mockResolvedValue(undefined);
  });

  it('should have test route working', async () => {
    const response = await request(app).get('/test');
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('Test route working');
  });

  describe('POST /api/admin/waitlist/invite', () => {
    it('should allow free users to be added to waitlist and send welcome email', async () => {
      const email = 'freeuser@example.com';
      const freeUser = {
        userId: 'user123',
        email: email,
        roles: ['free']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(freeUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.add.mockResolvedValue({ email, joinedAt: new Date().toISOString() });
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/admin/waitlist/invite')
        .send({
          email,
          sendInvitation: true
        });

      console.log('Response status:', response.status);
      console.log('Response body:', response.body);

      expect(response.status).toBe(201);
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith(email);
      expect(mockWaitlistDb.add).toHaveBeenCalled();
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith('user123', { roles: ['free', 'customer'] });
      expect(mockEmailService.sendWelcomeEmail).toHaveBeenCalledWith(email);
    });

    it('should block registered users (non-free) from being added to waitlist', async () => {
      const email = 'registered@example.com';
      const registeredUser = {
        userId: 'user456',
        email: email,
        roles: ['customer', 'partner']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(registeredUser);

      const response = await request(app)
        .post('/api/admin/waitlist/invite')
        .send({
          email,
          sendInvitation: true
        });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe('User already exists');
      expect(mockWaitlistDb.add).not.toHaveBeenCalled();
    });

    it('should allow new users (no existing user) to be added to waitlist', async () => {
      const email = 'newuser@example.com';

      mockUserDb.getUserByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.add.mockResolvedValue({ email, joinedAt: new Date().toISOString() });

      const response = await request(app)
        .post('/api/admin/waitlist/invite')
        .send({
          email,
          sendInvitation: true
        });

      expect(response.status).toBe(201);
      expect(mockEmailService.sendInvitation).toHaveBeenCalledWith(email);
    });
  });

  describe('PUT /api/admin/waitlist/:email/status', () => {
    it('should allow free users to have their status updated', async () => {
      const email = 'freeuser@example.com';
      const freeUser = {
        userId: 'user123',
        email: email,
        roles: ['free']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(freeUser);
      (mockWaitlistDb as any).updateStatus.mockResolvedValue({ email, status: 'invited' });
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/admin/waitlist/${email}/status`)
        .send({ status: 'invited' });

      expect(response.status).toBe(200);
      expect((mockWaitlistDb as any).updateStatus).toHaveBeenCalled();
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith('user123', { roles: ['free', 'customer'] });
      expect(mockEmailService.sendWelcomeEmail).toHaveBeenCalledWith(email);
    });

    it('should block registered users from having their status updated', async () => {
      const email = 'registered@example.com';
      const registeredUser = {
        userId: 'user456',
        email: email,
        roles: ['customer', 'partner']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(registeredUser);

      const response = await request(app)
        .put(`/api/admin/waitlist/${email}/status`)
        .send({ status: 'invited' });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('User already exists');
      expect((mockWaitlistDb as any).updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/waitlist/:email/create-user', () => {
    it('should allow free users to be created (upgraded to customer)', async () => {
      const email = 'freeuser@example.com';
      const freeUser = {
        userId: 'user123',
        email: email,
        roles: ['free']
      };
      const waitlistEntry = {
        email,
        fullName: 'Test User',
        companyName: 'Test Company'
      };

      mockUserDb.getUserByEmail.mockResolvedValue(freeUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).createUser.mockResolvedValue({ userId: 'new-user-id' });
      (mockWaitlistDb as any).updateStatus.mockResolvedValue({ email, status: 'completed' });

      const response = await request(app)
        .post(`/api/admin/waitlist/${email}/create-user`)
        .send({ roles: ['customer'] });

      expect(response.status).toBe(200);
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith('user123', { roles: ['free', 'customer'] });
      expect((mockWaitlistDb as any).updateStatus).toHaveBeenCalledWith(email, 'completed');
    });

    it('should block registered users from being created', async () => {
      const email = 'registered@example.com';
      const registeredUser = {
        userId: 'user456',
        email: email,
        roles: ['customer', 'partner']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(registeredUser);

      const response = await request(app)
        .post(`/api/admin/waitlist/${email}/create-user`)
        .send({ roles: ['customer'] });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('User already exists');
      expect((mockUserDb as any).createUser).not.toHaveBeenCalled();
    });
  });

  describe('Customer Role Addition Logic', () => {
    it('should add customer role to free users when sending welcome email', async () => {
      const email = 'freeuser@example.com';
      const freeUser = {
        userId: 'user123',
        email: email,
        roles: ['free']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(freeUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.add.mockResolvedValue({ email, joinedAt: new Date().toISOString() });
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/admin/waitlist/invite')
        .send({
          email,
          sendInvitation: true
        });

      expect(response.status).toBe(201);
      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user123', { 
        roles: ['free', 'customer'] 
      });
    });

    it('should not add customer role if user already has it', async () => {
      const email = 'freeuser@example.com';
      const freeUserWithCustomer = {
        userId: 'user123',
        email: email,
        roles: ['free', 'customer']
      };

      mockUserDb.getUserByEmail.mockResolvedValue(freeUserWithCustomer);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.add.mockResolvedValue({ email, joinedAt: new Date().toISOString() });

      const response = await request(app)
        .post('/api/admin/waitlist/invite')
        .send({
          email,
          sendInvitation: true
        });

      expect(response.status).toBe(201);
      expect((mockUserDb as any).updateUser).not.toHaveBeenCalled();
    });
  });
});