import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

describe('AgentModeService - Brand Guidelines Update', () => {
  let agentModeService: AgentModeService;
  const mockUserDb = require('../services/db').userDb;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('updateBrandGuidelines', () => {
    it('should create brand guidelines when they do not exist', async () => {
      const userId = 'test-user-123';
      const updateData = {
        brandData: {
          brandName: 'Test Brand',
          tagline: 'Test Tagline',
          primaryColor: '#FF0000',
        }
      };

      // Mock user without brand guidelines
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        brandGuidelines: null, // No existing brand guidelines
      });

      // Mock successful update
      mockUserDb.updateUser.mockResolvedValue({});

      // Call the private method using type assertion
      const result = await (agentModeService as any).updateBrandGuidelines(updateData, userId);

      // Verify the result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Brand guidelines updated successfully');
      expect(result.brandData.brandName).toBe('Test Brand');
      expect(result.brandData.tagline).toBe('Test Tagline');
      expect(result.brandData.primaryColor).toBe('#FF0000');

      // Verify that updateUser was called twice:
      // 1. First call to create initial brand guidelines structure
      // 2. Second call to update with the provided data
      expect(mockUserDb.updateUser).toHaveBeenCalledTimes(2);

      // Verify the first call (initial structure creation)
      const firstCall = mockUserDb.updateUser.mock.calls[0];
      expect(firstCall[0]).toBe(userId);
      expect(firstCall[1].brandGuidelines.brandData.brandName).toBe('');
      expect(firstCall[1].brandGuidelines.brandData.tagline).toBe('');
      expect(firstCall[1].brandGuidelines.brandData.primaryColor).toBe('');

      // Verify the second call (actual update)
      const secondCall = mockUserDb.updateUser.mock.calls[1];
      expect(secondCall[0]).toBe(userId);
      expect(secondCall[1].brandGuidelines.brandData.brandName).toBe('Test Brand');
      expect(secondCall[1].brandGuidelines.brandData.tagline).toBe('Test Tagline');
      expect(secondCall[1].brandGuidelines.brandData.primaryColor).toBe('#FF0000');
    });

    it('should update existing brand guidelines when they exist', async () => {
      const userId = 'test-user-123';
      const updateData = {
        brandData: {
          brandName: 'Updated Brand',
          tagline: 'Updated Tagline',
        }
      };

      // Mock user with existing brand guidelines
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        brandGuidelines: {
          brandData: {
            brandName: 'Original Brand',
            tagline: 'Original Tagline',
            primaryColor: '#0000FF',
            secondaryColor: '',
            fontFamily: '',
            toneOfVoice: '',
            keyMessages: [],
            brandValues: [],
            targetAudience: '',
            brandPersonality: '',
            primaryColorEnd: '',
            isGradient: false,
            founders: [],
          },
          attachments: [],
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
        },
      });

      // Mock successful update
      mockUserDb.updateUser.mockResolvedValue({});

      // Call the private method using type assertion
      const result = await (agentModeService as any).updateBrandGuidelines(updateData, userId);

      // Verify the result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Brand guidelines updated successfully');
      expect(result.brandData.brandName).toBe('Updated Brand');
      expect(result.brandData.tagline).toBe('Updated Tagline');
      expect(result.brandData.primaryColor).toBe('#0000FF'); // Should preserve existing value

      // Verify that updateUser was called only once (no initial creation needed)
      expect(mockUserDb.updateUser).toHaveBeenCalledTimes(1);

      // Verify the update call
      const updateCall = mockUserDb.updateUser.mock.calls[0];
      expect(updateCall[0]).toBe(userId);
      expect(updateCall[1].brandGuidelines.brandData.brandName).toBe('Updated Brand');
      expect(updateCall[1].brandGuidelines.brandData.tagline).toBe('Updated Tagline');
      expect(updateCall[1].brandGuidelines.brandData.primaryColor).toBe('#0000FF');
    });

    it('should return error when user is not found', async () => {
      const userId = 'non-existent-user';
      const updateData = {
        brandData: {
          brandName: 'Test Brand',
        }
      };

      // Mock user not found
      mockUserDb.getUserById.mockResolvedValue(null);

      // Call the private method using type assertion
      const result = await (agentModeService as any).updateBrandGuidelines(updateData, userId);

      // Verify the result
      expect(result.success).toBe(false);
      expect(result.message).toBe('User not found');
      expect(result.error).toBe('User not found');

      // Verify that updateUser was not called
      expect(mockUserDb.updateUser).not.toHaveBeenCalled();
    });
  });
});
