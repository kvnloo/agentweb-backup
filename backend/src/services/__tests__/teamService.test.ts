// @ts-nocheck
// Mock AWS SDK BEFORE importing teamService
const mockPromise = jest.fn();
const mockDocClient = {
  get: jest.fn().mockReturnValue({ promise: mockPromise }),
  put: jest.fn().mockReturnValue({ promise: mockPromise }),
  update: jest.fn().mockReturnValue({ promise: mockPromise }),
  query: jest.fn().mockReturnValue({ promise: mockPromise }),
  delete: jest.fn().mockReturnValue({ promise: mockPromise }),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocClient),
  },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { teamService } from '../teamService';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

describe('TeamService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPromise.mockReset();
  });

  describe('createTeam', () => {
    it('should create a team with correct attributes and return team data', async () => {
      mockPromise.mockResolvedValueOnce({}); // put team
      mockPromise.mockResolvedValueOnce({}); // put owner as member

      const result = await teamService.createTeam({
        name: 'My Team',
        ownerUserId: 'user-owner-1',
      });

      expect(result).toBeDefined();
      expect(result.teamId).toBe('mock-uuid-1234');
      expect(result.name).toBe('My Team');
      expect(result.ownerUserId).toBe('user-owner-1');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();

      // Verify DynamoDB put was called for the team
      expect(mockDocClient.put).toHaveBeenCalledTimes(2);
      const teamPutCall = mockDocClient.put.mock.calls[0][0];
      expect(teamPutCall.TableName).toBe(`${TABLE_PREFIX}AW-Teams`);
      expect(teamPutCall.Item.teamId).toBe('mock-uuid-1234');
      expect(teamPutCall.Item.name).toBe('My Team');

      // Verify owner was added as a member with 'owner' role
      const memberPutCall = mockDocClient.put.mock.calls[1][0];
      expect(memberPutCall.TableName).toBe(`${TABLE_PREFIX}AW-TeamMembers`);
      expect(memberPutCall.Item.teamId).toBe('mock-uuid-1234');
      expect(memberPutCall.Item.userId).toBe('user-owner-1');
      expect(memberPutCall.Item.role).toBe('owner');
    });

    it('should create a team with optional settings', async () => {
      mockPromise.mockResolvedValueOnce({}); // put team
      mockPromise.mockResolvedValueOnce({}); // put owner as member

      const settings = { maxMembers: 10, allowInvites: true };
      const result = await teamService.createTeam({
        name: 'Team With Settings',
        ownerUserId: 'user-owner-2',
        settings,
      });

      expect(result.settings).toEqual(settings);
    });

    it('should throw if DynamoDB put fails', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(
        teamService.createTeam({ name: 'Fail Team', ownerUserId: 'user-1' })
      ).rejects.toThrow('Error during createTeam');
    });
  });

  describe('getTeam', () => {
    it('should return team data by teamId', async () => {
      const team = {
        teamId: 'team-1',
        name: 'Test Team',
        ownerUserId: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      mockPromise.mockResolvedValueOnce({ Item: team });

      const result = await teamService.getTeam('team-1');

      expect(result).toEqual(team);
      expect(mockDocClient.get).toHaveBeenCalledWith({
        TableName: `${TABLE_PREFIX}AW-Teams`,
        Key: { teamId: 'team-1' },
      });
    });

    it('should return null if team not found', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });

      const result = await teamService.getTeam('nonexistent');
      expect(result).toBeNull();
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(teamService.getTeam('team-1')).rejects.toThrow(
        'Error during getTeam'
      );
    });
  });

  describe('updateTeam', () => {
    it('should update team name and settings', async () => {
      mockPromise.mockResolvedValueOnce({
        Attributes: {
          teamId: 'team-1',
          name: 'Updated Name',
          settings: { maxMembers: 20 },
        },
      });

      const result = await teamService.updateTeam('team-1', {
        name: 'Updated Name',
        settings: { maxMembers: 20 },
      });

      expect(result.name).toBe('Updated Name');
      expect(mockDocClient.update).toHaveBeenCalledTimes(1);
      const updateCall = mockDocClient.update.mock.calls[0][0];
      expect(updateCall.TableName).toBe(`${TABLE_PREFIX}AW-Teams`);
      expect(updateCall.Key).toEqual({ teamId: 'team-1' });
    });

    it('should throw if no fields provided', async () => {
      await expect(teamService.updateTeam('team-1', {})).rejects.toThrow(
        'No fields to update'
      );
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(
        teamService.updateTeam('team-1', { name: 'New' })
      ).rejects.toThrow('Error during updateTeam');
    });
  });

  describe('addMember', () => {
    it('should add a member with correct role', async () => {
      mockPromise.mockResolvedValueOnce({}); // put member

      const result = await teamService.addMember({
        teamId: 'team-1',
        userId: 'user-2',
        role: 'member',
        invitedBy: 'user-1',
      });

      expect(result.teamId).toBe('team-1');
      expect(result.userId).toBe('user-2');
      expect(result.role).toBe('member');
      expect(result.invitedBy).toBe('user-1');
      expect(result.status).toBe('active');
      expect(result.joinedAt).toBeDefined();

      const putCall = mockDocClient.put.mock.calls[0][0];
      expect(putCall.TableName).toBe(`${TABLE_PREFIX}AW-TeamMembers`);
    });

    it('should default role to member', async () => {
      mockPromise.mockResolvedValueOnce({});

      const result = await teamService.addMember({
        teamId: 'team-1',
        userId: 'user-3',
        invitedBy: 'user-1',
      });

      expect(result.role).toBe('member');
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(
        teamService.addMember({
          teamId: 'team-1',
          userId: 'user-2',
          invitedBy: 'user-1',
        })
      ).rejects.toThrow('Error during addMember');
    });
  });

  describe('removeMember', () => {
    it('should delete a team member', async () => {
      mockPromise.mockResolvedValueOnce({}); // delete

      await teamService.removeMember('team-1', 'user-2');

      expect(mockDocClient.delete).toHaveBeenCalledWith({
        TableName: `${TABLE_PREFIX}AW-TeamMembers`,
        Key: { teamId: 'team-1', userId: 'user-2' },
      });
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(
        teamService.removeMember('team-1', 'user-2')
      ).rejects.toThrow('Error during removeMember');
    });
  });

  describe('getTeamMembers', () => {
    it('should return all members for a team', async () => {
      const members = [
        { teamId: 'team-1', userId: 'user-1', role: 'owner' },
        { teamId: 'team-1', userId: 'user-2', role: 'member' },
      ];
      mockPromise.mockResolvedValueOnce({ Items: members });

      const result = await teamService.getTeamMembers('team-1');

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('owner');
      const queryCall = mockDocClient.query.mock.calls[0][0];
      expect(queryCall.TableName).toBe(`${TABLE_PREFIX}AW-TeamMembers`);
      expect(queryCall.KeyConditionExpression).toBe('teamId = :teamId');
    });

    it('should return empty array if no members', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [] });

      const result = await teamService.getTeamMembers('team-1');
      expect(result).toEqual([]);
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(teamService.getTeamMembers('team-1')).rejects.toThrow(
        'Error during getTeamMembers'
      );
    });
  });

  describe('getTeamForUser', () => {
    it('should return team membership for a user using GSI', async () => {
      const memberships = [
        { teamId: 'team-1', userId: 'user-1', role: 'owner' },
        { teamId: 'team-2', userId: 'user-1', role: 'member' },
      ];
      mockPromise.mockResolvedValueOnce({ Items: memberships });

      const result = await teamService.getTeamsForUser('user-1');

      expect(result).toHaveLength(2);
      const queryCall = mockDocClient.query.mock.calls[0][0];
      expect(queryCall.IndexName).toBe('userId-index');
      expect(queryCall.KeyConditionExpression).toBe('userId = :userId');
    });

    it('should return empty array if user has no teams', async () => {
      mockPromise.mockResolvedValueOnce({ Items: [] });

      const result = await teamService.getTeamsForUser('user-no-teams');
      expect(result).toEqual([]);
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(teamService.getTeamsForUser('user-1')).rejects.toThrow(
        'Error during getTeamsForUser'
      );
    });
  });

  describe('createInvite', () => {
    it('should create an invite with expiration', async () => {
      mockPromise.mockResolvedValueOnce({}); // put invite

      const result = await teamService.createInvite({
        teamId: 'team-1',
        email: 'newuser@example.com',
        role: 'member',
        invitedBy: 'user-1',
      });

      expect(result.inviteId).toBe('mock-uuid-1234');
      expect(result.teamId).toBe('team-1');
      expect(result.email).toBe('newuser@example.com');
      expect(result.role).toBe('member');
      expect(result.status).toBe('pending');
      expect(result.expiresAt).toBeDefined();

      const putCall = mockDocClient.put.mock.calls[0][0];
      expect(putCall.TableName).toBe(`${TABLE_PREFIX}AW-TeamInvites`);
    });

    it('should throw on DynamoDB error', async () => {
      mockPromise.mockRejectedValueOnce(new Error('DynamoDB error'));

      await expect(
        teamService.createInvite({
          teamId: 'team-1',
          email: 'fail@example.com',
          role: 'member',
          invitedBy: 'user-1',
        })
      ).rejects.toThrow('Error during createInvite');
    });
  });

  describe('getInvite', () => {
    it('should return invite by inviteId', async () => {
      const invite = {
        inviteId: 'invite-1',
        teamId: 'team-1',
        email: 'user@example.com',
        role: 'member',
        status: 'pending',
      };
      mockPromise.mockResolvedValueOnce({ Item: invite });

      const result = await teamService.getInvite('invite-1');

      expect(result).toEqual(invite);
      expect(mockDocClient.get).toHaveBeenCalledWith({
        TableName: `${TABLE_PREFIX}AW-TeamInvites`,
        Key: { inviteId: 'invite-1' },
      });
    });

    it('should return null if invite not found', async () => {
      mockPromise.mockResolvedValueOnce({ Item: undefined });

      const result = await teamService.getInvite('nonexistent');
      expect(result).toBeNull();
    });
  });
});
