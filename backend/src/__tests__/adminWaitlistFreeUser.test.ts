import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';
import { waitlistDb, WaitlistEntry } from '../services/waitlistDb';
import { emailService } from '../services/emailService';

// Mock the dependencies
jest.mock('../services/db');
jest.mock('../services/emailService');
jest.mock('../services/waitlistDb');
jest.mock('../services/subscriptionService', () => ({
  DEFAULT_PAGES: ['/'],
  getTierConfig: jest.fn().mockResolvedValue({
    allowedPages: ['/agent-mode'],
    allowedSkills: ['skill-1'],
  }),
}));
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

// Type that matches what the actual DynamoDB methods return
type DynamoDBWaitlistItem = {
  email: string;
  joinedAt: string;
  status: string;
  invitedAt: string | undefined;
  fullName: string | undefined;
  phoneNumber: string | undefined;
  companyName: string | undefined;
  requestReport: boolean;
  useCaseCategories: string[];
  useCaseDescription: string;
  supportNote: string;
  stripe_customer_id: string | undefined;
  productUsagePlan: string | undefined;
  monthlyMarketingSpend: string | undefined;
  businessArea: string | undefined;
  marketingChannels: string[];
};

// Helper function to create a complete DynamoDB waitlist item
const createWaitlistItem = (email: string, overrides: Partial<DynamoDBWaitlistItem> = {}): DynamoDBWaitlistItem => ({
  email,
  joinedAt: new Date().toISOString(),
  status: 'pending',
  invitedAt: undefined,
  fullName: undefined,
  phoneNumber: undefined,
  companyName: undefined,
  requestReport: false,
  useCaseCategories: [],
  useCaseDescription: '',
  supportNote: '',
  stripe_customer_id: undefined,
  productUsagePlan: undefined,
  monthlyMarketingSpend: undefined,
  businessArea: undefined,
  marketingChannels: [],
  ...overrides
});

// Set up mock implementations
(mockWaitlistDb as any).updateStatus = jest.fn().mockResolvedValue(createWaitlistItem('test@example.com'));
(mockWaitlistDb as any).getByEmail = jest.fn().mockResolvedValue(undefined);
(mockWaitlistDb as any).add = jest.fn().mockResolvedValue(createWaitlistItem('test@example.com'));
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
      mockWaitlistDb.add.mockResolvedValue(createWaitlistItem(email));
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
      mockWaitlistDb.add.mockResolvedValue(createWaitlistItem(email));

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
      (mockWaitlistDb as any).updateStatus.mockResolvedValue(createWaitlistItem(email, { status: 'invited' }));
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

  describe('PUT /api/admin/waitlist/:email', () => {
    it('should update waitlist entry details when entry exists', async () => {
      const email = 'editwaitlist@example.com';
      const existingEntry = createWaitlistItem(email, { fullName: 'Old Name' });
      const updates = {
        fullName: 'New Name',
        supportNote: 'Updated note',
      };
      const updatedEntry = createWaitlistItem(email, {
        fullName: 'New Name',
        supportNote: 'Updated note',
      });

      mockWaitlistDb.getByEmail.mockResolvedValue(existingEntry);
      (mockWaitlistDb as any).updateDetails.mockResolvedValue(updatedEntry);

      const response = await request(app)
        .put(`/api/admin/waitlist/${email}`)
        .send(updates);

      expect(response.status).toBe(200);
      expect((mockWaitlistDb as any).updateDetails).toHaveBeenCalledWith(email, updates);
      expect(response.body).toEqual(updatedEntry);
    });

    it('should return 404 when waitlist entry does not exist', async () => {
      const email = 'missing@example.com';

      mockWaitlistDb.getByEmail.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/admin/waitlist/${email}`)
        .send({ fullName: 'Nope' });

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Waitlist entry not found');
      expect((mockWaitlistDb as any).updateDetails).not.toHaveBeenCalled();
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
      const waitlistEntry = createWaitlistItem(email, {
        fullName: 'Test User',
        companyName: 'Test Company'
      });

      mockUserDb.getUserByEmail.mockResolvedValue(freeUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).createUser.mockResolvedValue({ userId: 'new-user-id' });
      (mockWaitlistDb as any).updateStatus.mockResolvedValue(createWaitlistItem(email, { status: 'completed' }));

      const response = await request(app)
        .post(`/api/admin/waitlist/${email}/create-user`)
        .send({ roles: ['customer'] });

      expect(response.status).toBe(200);
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith('user123', {
        roles: ['free', 'customer'],
        subscriptionType: 'Free',
        allowedPages: ['/agent-mode'],
        allowedSkills: ['skill-1'],
      });
      expect((mockWaitlistDb as any).updateStatus).toHaveBeenCalledWith(email, 'completed');
    });

    it('should create new waitlist users with Free tier defaults', async () => {
      const email = 'newuser@example.com';
      const waitlistEntry = createWaitlistItem(email, {
        fullName: 'New User',
        companyName: 'New Company',
      });
      mockUserDb.getUserByEmail.mockResolvedValue(undefined);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).createUser.mockImplementation(
        async (_email: string, userId: string) => ({
          userId,
          email,
          displayName: 'New User',
          roles: ['customer'],
        })
      );
      (mockUserDb as any).updateUser.mockImplementation(
        async (userId: string, updates: any) => ({
          userId,
          email,
          displayName: 'New User',
          roles: ['customer'],
          ...updates,
        })
      );
      (mockWaitlistDb as any).updateStatus.mockResolvedValue(createWaitlistItem(email, { status: 'completed' }));

      const response = await request(app)
        .post(`/api/admin/waitlist/${email}/create-user`)
        .send({ roles: ['customer'] });

      expect(response.status).toBe(200);
      const createdUserId = (mockUserDb as any).createUser.mock.calls[0][1];
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith(createdUserId, {
        subscriptionType: 'Free',
        allowedPages: ['/agent-mode'],
        allowedSkills: ['skill-1'],
      });
      expect(response.body.user).toMatchObject({
        userId: createdUserId,
        email,
        displayName: 'New User',
        roles: ['customer'],
      });

      // The temporary password must be CSPRNG-generated: 16 chars from the
      // expected charset (no Math.random-based generation).
      const welcomeCall = (mockEmailService as any).sendWelcomeEmail.mock.calls[0];
      const sentPassword: string = welcomeCall[1];
      expect(sentPassword).toHaveLength(16);
      expect(sentPassword).toMatch(/^[a-zA-Z0-9!@#$%^&*]{16}$/);
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
      mockWaitlistDb.add.mockResolvedValue(createWaitlistItem(email));
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
      mockWaitlistDb.add.mockResolvedValue(createWaitlistItem(email));

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
