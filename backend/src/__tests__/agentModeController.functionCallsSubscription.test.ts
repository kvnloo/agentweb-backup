import { Request, Response } from 'express';

// Mock AgentModeService used inside the controller
jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image', description: 'Generate images' } },
      { type: 'function', function: { name: 'generate_video', description: 'Generate videos' } },
      { type: 'function', function: { description: 'Missing name' } },
      { type: 'function' },
      { type: 'non-function', other: true },
    ],
  })),
  // Some tests import the singleton, keep a minimal stub
  agentModeService: {
    getAvailableTools: () => [
      { type: 'function', function: { name: 'generate_image', description: 'Generate images' } },
      { type: 'function', function: { name: 'generate_video', description: 'Generate videos' } },
      { type: 'function', function: { name: 'you_search_web', description: 'Search the web' } },
      { type: 'function', function: { description: 'Missing name' } },
      { type: 'function' },
      { type: 'non-function', other: true },
    ],
    getFoundationToolNames: () => new Set(['you_search_web']),
  },
}));

// Mock subscriptionService used by getAvailableFunctionCalls
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async (_userId: string) => ['generate_image']),
  filterFunctionCalls: jest.fn((allTools: any[], allowed: string[]) =>
    allTools.filter((t) => t.type !== 'function' || !t.function?.name || allowed.includes(t.function.name)),
  ),
}));

import { agentModeController } from '../controllers/agentModeController';
import { getAllowedFunctionCalls, filterFunctionCalls } from '../services/subscriptionService';

const mockedGetAllowed = getAllowedFunctionCalls as jest.MockedFunction<typeof getAllowedFunctionCalls>;
const mockedFilter = filterFunctionCalls as jest.MockedFunction<typeof filterFunctionCalls>;

const makeRes = () => {
  const res: Partial<Response> = {};
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res as any);
  return res as Response;
};

describe('agentModeController.getAvailableFunctionCalls subscription behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should include foundation tools for non-admin users even when not in subscription', async () => {
    // getAllowedFunctionCalls returns only 'generate_image' — does NOT include 'you_search_web'
    mockedGetAllowed.mockResolvedValueOnce(['generate_image']);

    const req = {
      user: { userId: 'user-1', isAdmin: false },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    // filterFunctionCalls should have been called with foundation tools added to allowed list
    expect(mockedFilter).toHaveBeenCalled();
    const allowedArg = mockedFilter.mock.calls[0][1];
    expect(allowedArg).toContain('generate_image');
    expect(allowedArg).toContain('you_search_web'); // Foundation tool injected

    // Response should contain both the subscription tool and the foundation tool
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.functionCalls).toEqual(
      expect.arrayContaining([
        { name: 'generate_image', description: 'Generate images' },
        { name: 'you_search_web', description: 'Search the web' },
      ])
    );
  });

  it('should not duplicate foundation tools if already in subscription', async () => {
    // getAllowedFunctionCalls already includes 'you_search_web'
    mockedGetAllowed.mockResolvedValueOnce(['generate_image', 'you_search_web']);

    const req = {
      user: { userId: 'user-1', isAdmin: false },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    const allowedArg = mockedFilter.mock.calls[0][1];
    const searchWebCount = allowedArg.filter((n: string) => n === 'you_search_web').length;
    expect(searchWebCount).toBe(1); // Not duplicated
  });

  it('should return all function calls for admin users (no subscription filtering)', async () => {
    const req = {
      user: { userId: 'admin-1', isAdmin: true },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    // For admin users we should NOT call subscriptionService helpers
    expect(mockedGetAllowed).not.toHaveBeenCalled();
    expect(mockedFilter).not.toHaveBeenCalled();

    // All function tools should be returned
    expect(res.json).toHaveBeenCalledWith({
      functionCalls: [
        { name: 'generate_image', description: 'Generate images' },
        { name: 'generate_video', description: 'Generate videos' },
        { name: 'you_search_web', description: 'Search the web' },
      ],
    });
  });

  it('should not exclude foundation tools even with forSkillConfig=true', async () => {
    const req = {
      user: { userId: 'admin-1', isAdmin: true },
      query: { forSkillConfig: 'true' },
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    // Foundation tools should NOT be excluded — forSkillConfig filter was removed
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.functionCalls).toEqual(
      expect.arrayContaining([
        { name: 'you_search_web', description: 'Search the web' },
      ])
    );
  });

  it('should include foundation tools when forSkillConfig is not set', async () => {
    const req = {
      user: { userId: 'admin-1', isAdmin: true },
      query: {},
    } as unknown as Request;
    const res = makeRes();

    await agentModeController.getAvailableFunctionCalls(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.functionCalls.some((fc: any) => fc.name === 'you_search_web')).toBe(true);
  });
});
