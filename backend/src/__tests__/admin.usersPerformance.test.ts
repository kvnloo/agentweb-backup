// Mock AWS SDK before imports
const mockQuery = jest.fn();
const mockScan = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: mockQuery })),
      scan: jest.fn(() => ({ promise: mockScan })),
      get: jest.fn(() => ({ promise: jest.fn() })),
      put: jest.fn(() => ({ promise: jest.fn() })),
      update: jest.fn(() => ({ promise: jest.fn() })),
      delete: jest.fn(() => ({ promise: jest.fn() })),
    })),
  },
  S3: jest.fn(() => ({})),
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

import { userDb, taskDb, workflowDb } from "../services/db";

describe("Admin Users Tab Performance", () => {
  let getUserTaskCountSpy: jest.SpyInstance;
  let getTasksByUserIdSpy: jest.SpyInstance;
  let getWorkflowCountSpy: jest.SpyInstance;
  let getChatSessionCountSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    getUserTaskCountSpy = jest
      .spyOn(taskDb, "getUserTaskCount")
      .mockResolvedValue(5);

    getTasksByUserIdSpy = jest.spyOn(taskDb, "getTasksByUserId");

    getWorkflowCountSpy = jest
      .spyOn(workflowDb, "getUserWorkflowCount")
      .mockResolvedValue(2);

    getChatSessionCountSpy = jest
      .spyOn(userDb as any, "getChatSessionCount")
      .mockResolvedValue(3);

    // Mock the scan used by getAllUsers
    mockScan.mockResolvedValue({
      Items: [
        { userId: "user-1", email: "a@test.com" },
        { userId: "user-2", email: "b@test.com" },
      ],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should call getUserTaskCount instead of getTasksByUserId", async () => {
    await userDb.getAllUsers();

    expect(getUserTaskCountSpy).toHaveBeenCalledTimes(2);
    expect(getUserTaskCountSpy).toHaveBeenCalledWith("user-1");
    expect(getUserTaskCountSpy).toHaveBeenCalledWith("user-2");
    expect(getTasksByUserIdSpy).not.toHaveBeenCalled();
  });

  it("should return correct taskCount from getUserTaskCount", async () => {
    mockScan.mockResolvedValue({
      Items: [{ userId: "user-1", email: "a@test.com" }],
    });
    getUserTaskCountSpy.mockResolvedValueOnce(7);

    const result = await userDb.getAllUsers();

    expect(result[0].taskCount).toBe(7);
    expect(result[0].workflowCount).toBe(2);
    expect(result[0].chatSessionCount).toBe(3);
  });

  it("should handle zero tasks gracefully", async () => {
    mockScan.mockResolvedValue({
      Items: [{ userId: "user-1", email: "a@test.com" }],
    });
    getUserTaskCountSpy.mockResolvedValueOnce(0);

    const result = await userDb.getAllUsers();

    expect(result[0].taskCount).toBe(0);
  });

  it("should handle empty user list", async () => {
    mockScan.mockResolvedValue({ Items: [] });

    const result = await userDb.getAllUsers();

    expect(result).toEqual([]);
    expect(getUserTaskCountSpy).not.toHaveBeenCalled();
  });
});
