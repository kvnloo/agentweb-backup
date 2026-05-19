import { DocumentClient } from "aws-sdk/clients/dynamodb";

const mockQuery = jest.fn();
jest.mock("aws-sdk", () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: (...args: any[]) => ({ promise: () => mockQuery(...args) }),
        scan: () => ({ promise: () => Promise.reject(new Error("scan() should not be called")) }),
        get: () => ({ promise: () => Promise.resolve({}) }),
        put: () => ({ promise: () => Promise.resolve({}) }),
        update: () => ({ promise: () => Promise.resolve({}) }),
        delete: () => ({ promise: () => Promise.resolve({}) }),
        batchWrite: () => ({ promise: () => Promise.resolve({}) }),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

import { orgDb } from "../services/db";

describe("getOrgMembers via OrgIdIndex", () => {
  beforeEach(() => mockQuery.mockReset());

  it("queries the OrgIdIndex GSI with the correct partition key", async () => {
    mockQuery.mockResolvedValueOnce({
      Items: [
        { userId: "u1", orgId: "org-1" },
        { userId: "u2", orgId: "org-1" },
      ],
    });

    const members = await orgDb.getOrgMembers("org-1");
    expect(members).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const args = mockQuery.mock.calls[0][0];
    expect(args.IndexName).toBe("OrgIdIndex");
    expect(args.KeyConditionExpression).toContain("orgId");
    expect(args.ExpressionAttributeValues[":orgId"]).toBe("org-1");
  });

  it("excludes tombstoned users", async () => {
    mockQuery.mockResolvedValueOnce({
      Items: [
        { userId: "u1", orgId: "org-1" },
        { userId: "deleted_abc", orgId: "org-1" },
      ],
    });
    const members = await orgDb.getOrgMembers("org-1");
    expect(members.map((m) => m.userId)).toEqual(["u1"]);
  });
});
