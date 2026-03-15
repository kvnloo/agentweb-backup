/**
 * Tests for AgencyService — CRUD operations on agency-client relationships.
 * AW-AgencyClients DynamoDB table: agencyTeamId (PK) + clientTeamId (SK)
 */

// Mock AWS SDK before imports
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({})),
  };
});

import { AgencyService, AgencyClient } from '../services/agencyService';

describe('AgencyService', () => {
  let service: AgencyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgencyService();

    // Default: all DynamoDB calls return empty
    Object.keys(mockDocumentClientMethods).forEach((method) => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  // ─── linkClient ─────────────────────────────────────────────

  describe('linkClient', () => {
    // FAIL test 1: should reject when agencyTeamId equals clientTeamId
    it('should reject linking a team to itself', async () => {
      await expect(
        service.linkClient('team-1', 'team-1', 'user-1')
      ).rejects.toThrow(/cannot link.*itself/i);
    });

    // FAIL test 2: should reject empty agencyTeamId
    it('should reject empty agencyTeamId', async () => {
      await expect(
        service.linkClient('', 'team-2', 'user-1')
      ).rejects.toThrow(/agencyTeamId.*required/i);
    });

    // FAIL test 3: should reject empty clientTeamId
    it('should reject empty clientTeamId', async () => {
      await expect(
        service.linkClient('team-1', '', 'user-1')
      ).rejects.toThrow(/clientTeamId.*required/i);
    });

    // SUCCESS test: should create an agency-client link
    it('should create an agency-client link successfully', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await service.linkClient('agency-1', 'client-1', 'user-1');

      expect(result).toBeDefined();
      expect(result.agencyTeamId).toBe('agency-1');
      expect(result.clientTeamId).toBe('client-1');
      expect(result.status).toBe('active');
      expect(result.linkedBy).toBe('user-1');
      expect(result.linkedAt).toBeDefined();

      expect(mockDocumentClientMethods.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'active',
            linkedBy: 'user-1',
          }),
        })
      );
    });

    // SUCCESS test: should use condition expression to prevent duplicate links
    it('should use condition expression to prevent duplicate active links', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await service.linkClient('agency-1', 'client-1', 'user-1');

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.ConditionExpression).toBeDefined();
    });
  });

  // ─── unlinkClient ──────────────────────────────────────────

  describe('unlinkClient', () => {
    // FAIL test 1: should reject empty agencyTeamId
    it('should reject empty agencyTeamId', async () => {
      await expect(
        service.unlinkClient('', 'client-1')
      ).rejects.toThrow(/agencyTeamId.*required/i);
    });

    // FAIL test 2: should reject empty clientTeamId
    it('should reject empty clientTeamId', async () => {
      await expect(
        service.unlinkClient('agency-1', '')
      ).rejects.toThrow(/clientTeamId.*required/i);
    });

    // FAIL test 3: should throw when link does not exist
    it('should throw when link does not exist', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      await expect(
        service.unlinkClient('agency-1', 'client-99')
      ).rejects.toThrow(/not found/i);
    });

    // SUCCESS test: should delete the agency-client link
    it('should delete the agency-client link', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'active',
          },
        }),
      });
      mockDocumentClientMethods.delete.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await service.unlinkClient('agency-1', 'client-1');

      expect(mockDocumentClientMethods.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
          },
        })
      );
    });
  });

  // ─── getAgencyClients ──────────────────────────────────────

  describe('getAgencyClients', () => {
    // FAIL test 1: should reject empty agencyTeamId
    it('should reject empty agencyTeamId', async () => {
      await expect(
        service.getAgencyClients('')
      ).rejects.toThrow(/agencyTeamId.*required/i);
    });

    // FAIL test 2: should return empty array when no clients
    it('should return empty array when agency has no clients', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      const result = await service.getAgencyClients('agency-1');
      expect(result).toEqual([]);
    });

    // SUCCESS test: should return list of clients
    it('should return list of linked clients', async () => {
      const mockClients: AgencyClient[] = [
        {
          agencyTeamId: 'agency-1',
          clientTeamId: 'client-1',
          status: 'active',
          linkedAt: '2026-01-01T00:00:00.000Z',
          linkedBy: 'user-1',
        },
        {
          agencyTeamId: 'agency-1',
          clientTeamId: 'client-2',
          status: 'active',
          linkedAt: '2026-01-02T00:00:00.000Z',
          linkedBy: 'user-1',
        },
      ];

      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: mockClients }),
      });

      const result = await service.getAgencyClients('agency-1');

      expect(result).toHaveLength(2);
      expect(result[0].clientTeamId).toBe('client-1');
      expect(result[1].clientTeamId).toBe('client-2');

      expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
        expect.objectContaining({
          KeyConditionExpression: expect.stringContaining('agencyTeamId'),
        })
      );
    });
  });

  // ─── getClientAgencies ─────────────────────────────────────

  describe('getClientAgencies', () => {
    // FAIL test 1: should reject empty clientTeamId
    it('should reject empty clientTeamId', async () => {
      await expect(
        service.getClientAgencies('')
      ).rejects.toThrow(/clientTeamId.*required/i);
    });

    // SUCCESS test: should query GSI and return agencies for a client
    it('should return agencies for a given client', async () => {
      const mockAgencies: AgencyClient[] = [
        {
          agencyTeamId: 'agency-1',
          clientTeamId: 'client-1',
          status: 'active',
          linkedAt: '2026-01-01T00:00:00.000Z',
          linkedBy: 'user-1',
        },
      ];

      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: mockAgencies }),
      });

      const result = await service.getClientAgencies('client-1');

      expect(result).toHaveLength(1);
      expect(result[0].agencyTeamId).toBe('agency-1');

      // Should use GSI for reverse lookup
      expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
        expect.objectContaining({
          IndexName: expect.any(String),
          KeyConditionExpression: expect.stringContaining('clientTeamId'),
        })
      );
    });
  });

  // ─── isAgencyForClient ─────────────────────────────────────

  describe('isAgencyForClient', () => {
    // FAIL test 1: should return false for non-existent link
    it('should return false when no link exists', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      const result = await service.isAgencyForClient('agency-1', 'client-1');
      expect(result).toBe(false);
    });

    // FAIL test 2: should return false for revoked link
    it('should return false for revoked link', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'revoked',
          },
        }),
      });

      const result = await service.isAgencyForClient('agency-1', 'client-1');
      expect(result).toBe(false);
    });

    // SUCCESS test: should return true for active link
    it('should return true for active link', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'active',
          },
        }),
      });

      const result = await service.isAgencyForClient('agency-1', 'client-1');
      expect(result).toBe(true);
    });
  });

  // ─── revokeAgencyAccess (client-side) ──────────────────────

  describe('revokeAgencyAccess', () => {
    // FAIL test 1: should throw when link does not exist
    it('should throw when link does not exist', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      await expect(
        service.revokeAgencyAccess('agency-1', 'client-1')
      ).rejects.toThrow(/not found/i);
    });

    // SUCCESS test: should update status to revoked
    it('should update status to revoked', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'active',
          },
        }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
            status: 'revoked',
          },
        }),
      });

      const result = await service.revokeAgencyAccess('agency-1', 'client-1');

      expect(result.status).toBe('revoked');
      expect(mockDocumentClientMethods.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: {
            agencyTeamId: 'agency-1',
            clientTeamId: 'client-1',
          },
          UpdateExpression: expect.stringContaining('status'),
        })
      );
    });
  });
});
