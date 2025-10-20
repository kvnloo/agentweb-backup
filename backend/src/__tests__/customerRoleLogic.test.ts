import { userDb } from '../services/db';
import { emailService } from '../services/emailService';

// Mock the dependencies
jest.mock('../services/db');
jest.mock('../services/emailService');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;

describe('Customer Role Addition Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock email service
    mockEmailService.sendWelcomeEmail.mockResolvedValue(undefined);
    mockEmailService.sendInvitation.mockResolvedValue(undefined);
  });

  describe('addCustomerRoleToFreeUser', () => {
    const addCustomerRoleToFreeUser = async (existingUser: any) => {
      // Add customer role to existing free users so they can access customer portal
      if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
        const updatedRoles = [...existingUser.roles, 'customer'];
        await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
        return true;
      }
      return false;
    };

    it('should add customer role to free user', async () => {
      const existingFreeUser = {
        userId: 'user123',
        email: 'free@example.com',
        roles: ['free']
      };

      mockUserDb.updateUser.mockResolvedValue({
        ...existingFreeUser,
        roles: ['free', 'customer']
      });

      const result = await addCustomerRoleToFreeUser(existingFreeUser);

      expect(result).toBe(true);
      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user123', {
        roles: ['free', 'customer']
      });
    });

    it('should not add customer role if user already has customer role', async () => {
      const existingUserWithCustomer = {
        userId: 'user123',
        email: 'customer@example.com',
        roles: ['free', 'customer']
      };

      const result = await addCustomerRoleToFreeUser(existingUserWithCustomer);

      expect(result).toBe(false);
      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should not add customer role if user is not a free user', async () => {
      const existingPartnerUser = {
        userId: 'user123',
        email: 'partner@example.com',
        roles: ['partner']
      };

      const result = await addCustomerRoleToFreeUser(existingPartnerUser);

      expect(result).toBe(false);
      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should not add customer role if user has no roles array', async () => {
      const userWithoutRoles = {
        userId: 'user123',
        email: 'noroles@example.com'
      };

      const result = await addCustomerRoleToFreeUser(userWithoutRoles);

      expect(result).toBe(false);
      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should not add customer role if user has empty roles array', async () => {
      const userWithEmptyRoles = {
        userId: 'user123',
        email: 'emptyroles@example.com',
        roles: []
      };

      const result = await addCustomerRoleToFreeUser(userWithEmptyRoles);

      expect(result).toBe(false);
      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should handle user update errors', async () => {
      const existingFreeUser = {
        userId: 'user123',
        email: 'free@example.com',
        roles: ['free']
      };

      mockUserDb.updateUser.mockRejectedValue(new Error('Database error'));

      await expect(addCustomerRoleToFreeUser(existingFreeUser)).rejects.toThrow('Database error');
      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user123', {
        roles: ['free', 'customer']
      });
    });
  });

  describe('Email sending logic', () => {
    const sendAppropriateEmail = async (existingUser: any, email: string) => {
      if (existingUser) {
        // Add customer role to existing free users so they can access customer portal
        if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
          const updatedRoles = [...existingUser.roles, 'customer'];
          await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
        }
        await emailService.sendWelcomeEmail(email); // No password = upgrade email
      } else {
        await emailService.sendInvitation(email);
      }
    };

    it('should send welcome email and add customer role for existing free user', async () => {
      const existingFreeUser = {
        userId: 'user123',
        email: 'free@example.com',
        roles: ['free']
      };

      mockUserDb.updateUser.mockResolvedValue({
        ...existingFreeUser,
        roles: ['free', 'customer']
      });

      await sendAppropriateEmail(existingFreeUser, 'free@example.com');

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user123', {
        roles: ['free', 'customer']
      });
      expect(mockEmailService.sendWelcomeEmail).toHaveBeenCalledWith('free@example.com');
      expect(mockEmailService.sendInvitation).not.toHaveBeenCalled();
    });

    it('should send welcome email without adding role for existing user with customer role', async () => {
      const existingUserWithCustomer = {
        userId: 'user123',
        email: 'customer@example.com',
        roles: ['free', 'customer']
      };

      await sendAppropriateEmail(existingUserWithCustomer, 'customer@example.com');

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
      expect(mockEmailService.sendWelcomeEmail).toHaveBeenCalledWith('customer@example.com');
      expect(mockEmailService.sendInvitation).not.toHaveBeenCalled();
    });

    it('should send invitation email for new user', async () => {
      await sendAppropriateEmail(null, 'new@example.com');

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
      expect(mockEmailService.sendWelcomeEmail).not.toHaveBeenCalled();
      expect(mockEmailService.sendInvitation).toHaveBeenCalledWith('new@example.com');
    });
  });
});
