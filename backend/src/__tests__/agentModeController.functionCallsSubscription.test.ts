import { Request, Response } from 'express';

// Mock the tools module with ToolRegistry
const mockToolRegistry = {
  getAll: jest.fn(() => [
    { 
      name: 'generate_image', 
      category: 'content',
      schema: { name: 'generate_image', description: 'Generate images', parameters: {} },
      deprecated: false
    },
    { 
      name: 'generate_video', 
      category: 'content',
      schema: { name: 'generate_video', description: 'Generate videos', parameters: {} },
      deprecated: false
    },
  ]),
};

jest.mock('../tools', () => ({
  toolRegistry: mockToolRegistry,
  registerAllTools: jest.fn(),
  allToolDefinitions: [],
}));

// Mock SubscriptionToolFilter
const mockFilterToolsBySubscription = jest.fn(async (tools: any[], _userId: string) => {
  // Simulate filtering - only return 'generate_image'
  return tools.filter(t => t.name === 'generate_image');
});

jest.mock('../tools/SubscriptionToolFilter', () => ({
  filterToolsBySubscription: mockFilterToolsBySubscription,
}));

import { agentModeController } from '../controllers/agentModeController';

const makeRes = () => {
  const res: Partial<Response> = {};
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res as any);
  return res as Response;
};

describe('agentModeController.getAvailableFunctionCalls subscription behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations
    mockToolRegistry.getAll.mockReturnValue([
      { 
        name: 'generate_image', 
        category: 'content',
        schema: { name: 'generate_image', description: 'Generate images', parameters: {} },
        deprecated: false
      },
      { 
        name: 'generate_video', 
        category: 'content',
        schema: { name: 'generate_video', description: 'Generate videos', parameters: {} },
        deprecated: false
      },
    ]);
  });

  it('should filter function calls based on subscription for non-admin users', async () => {
    const req = {
      user: { userId: 'user-1', isAdmin: false },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    // Should have used filterToolsBySubscription
    expect(mockFilterToolsBySubscription).toHaveBeenCalledWith(
      expect.any(Array),
      'user-1'
    );

    // Response should only contain the allowed function
    expect(res.json).toHaveBeenCalledWith({
      functionCalls: [
        { name: 'generate_image', description: 'Generate images' },
      ],
    });
  });

  it('should return all function calls for admin users (no subscription filtering)', async () => {
    const req = {
      user: { userId: 'admin-1', isAdmin: true },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    // For admin users we should NOT call filterToolsBySubscription
    expect(mockFilterToolsBySubscription).not.toHaveBeenCalled();

    // All function tools should be returned
    expect(res.json).toHaveBeenCalledWith({
      functionCalls: [
        { name: 'generate_image', description: 'Generate images' },
        { name: 'generate_video', description: 'Generate videos' },
      ],
    });
  });
});
