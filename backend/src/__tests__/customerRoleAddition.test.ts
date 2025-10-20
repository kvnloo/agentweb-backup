import { userDb } from '../services/db';

// Mock the database service
jest.mock('../services/db');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('Customer Role Addition Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('addCustomerRoleToFreeUser', () => {
    const addCustomerRoleToFreeUser = async (existingUser: any) => {
      // Add customer role to existing free users so they can access customer portal
      if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
        const updatedRoles = [...existingUser.roles, 'customer'];
        await mockUserDb.updateUser(existingUser.userId, { roles: updatedRoles });
      }
    };

    it('should add customer role to a free user without customer role', async () => {
      const user = { userId: 'user1', email: 'test@example.com', roles: ['free'] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user1', { roles: ['free', 'customer'] });
    });

    it('should not add customer role if user already has customer role', async () => {
      const user = { userId: 'user2', email: 'test2@example.com', roles: ['free', 'customer'] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should not add customer role if user is not a free user', async () => {
      const user = { userId: 'user3', email: 'test3@example.com', roles: ['partner'] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should handle user with no roles array', async () => {
      const user = { userId: 'user4', email: 'test4@example.com' }; // No roles property
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should handle user with empty roles array', async () => {
      const user = { userId: 'user5', email: 'test5@example.com', roles: [] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should handle user with multiple roles including free and customer', async () => {
      const user = { userId: 'user6', email: 'test6@example.com', roles: ['free', 'customer', 'partner'] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });

    it('should handle user with free role and other non-customer roles', async () => {
      const user = { userId: 'user7', email: 'test7@example.com', roles: ['free', 'partner'] };
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      await addCustomerRoleToFreeUser(user);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith('user7', { roles: ['free', 'partner', 'customer'] });
    });
  });

  describe('User Role Validation Logic', () => {
    const isFreeUserOnly = (user: any) => {
      return user.roles && user.roles.includes('free') && !user.roles.some((role: string) => role !== 'free');
    };

    const isRegisteredUser = (user: any) => {
      return user.roles && user.roles.some((role: string) => role !== 'free');
    };

    it('should correctly identify free user only', () => {
      const freeUser = { roles: ['free'] };
      const freeUserWithCustomer = { roles: ['free', 'customer'] };
      const registeredUser = { roles: ['customer', 'partner'] };
      const noRolesUser = {};

      expect(isFreeUserOnly(freeUser)).toBe(true);
      expect(isFreeUserOnly(freeUserWithCustomer)).toBe(false);
      expect(isFreeUserOnly(registeredUser)).toBe(false);
      expect(isFreeUserOnly(noRolesUser)).toBeFalsy();
    });

    it('should correctly identify registered user', () => {
      const freeUser = { roles: ['free'] };
      const freeUserWithCustomer = { roles: ['free', 'customer'] };
      const registeredUser = { roles: ['customer', 'partner'] };
      const noRolesUser = {};

      expect(isRegisteredUser(freeUser)).toBe(false);
      expect(isRegisteredUser(freeUserWithCustomer)).toBe(true);
      expect(isRegisteredUser(registeredUser)).toBe(true);
      expect(isRegisteredUser(noRolesUser)).toBeFalsy();
    });
  });
});
