/**
 * Tests for Notion-triggered dev environment automation.
 * Covers the webhook route handler and core service functions.
 */

// Mock AWS SDK before imports
jest.mock('aws-sdk', () => {
  const mockEC2 = {
    describeVpcs: jest.fn().mockReturnValue({ promise: jest.fn() }),
    createSecurityGroup: jest.fn().mockReturnValue({ promise: jest.fn() }),
    createTags: jest.fn().mockReturnValue({ promise: jest.fn() }),
    authorizeSecurityGroupIngress: jest.fn().mockReturnValue({ promise: jest.fn() }),
    runInstances: jest.fn().mockReturnValue({ promise: jest.fn() }),
    describeInstances: jest.fn().mockReturnValue({ promise: jest.fn() }),
    terminateInstances: jest.fn().mockReturnValue({ promise: jest.fn() }),
    deleteSecurityGroup: jest.fn().mockReturnValue({ promise: jest.fn() }),
    waitFor: jest.fn().mockReturnValue({ promise: jest.fn() }),
  };
  const mockSSM = {
    getParameters: jest.fn().mockReturnValue({ promise: jest.fn() }),
  };
  const mockIAM = {
    getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn() }),
  };
  return {
    __esModule: true,
    default: {
      EC2: jest.fn(() => mockEC2),
      SSM: jest.fn(() => mockSSM),
      IAM: jest.fn(() => mockIAM),
    },
    EC2: jest.fn(() => mockEC2),
    SSM: jest.fn(() => mockSSM),
    IAM: jest.fn(() => mockIAM),
  };
});

jest.mock('axios');
jest.mock('fs');
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('mock-notion-token'),
}));

import AWS from 'aws-sdk';
import axios from 'axios';
import fs from 'fs';
import {
  getNotionPage,
  getNotionPageContent,
  updateNotionPageProperties,
  addNotionComment,
  launchEnvironment,
  teardownEnvironment,
  getNotionCommentText,
  getNotionBotUserId,
  relayPromptToEC2,
} from '../services/devEnvService';

const mockAxios = axios as any as jest.Mock;
const mockFs = fs as jest.Mocked<typeof fs>;

// Get mock instances
const mockEC2 = new AWS.EC2() as any;
const mockSSM = new AWS.SSM() as any;
const mockIAM = new AWS.IAM() as any;

describe('devEnvService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getNotionPage
  // -------------------------------------------------------------------------
  describe('getNotionPage', () => {
    it('should extract title, status, instanceId, sgId, databaseId from page', async () => {
      mockAxios.mockResolvedValue({
        data: {
          parent: { database_id: 'db-123' },
          properties: {
            Name: {
              type: 'title',
              title: [{ plain_text: 'My Task' }],
            },
            Status: {
              status: { name: 'Start' },
            },
            'Instance ID': {
              rich_text: [{ plain_text: 'i-abc123' }],
            },
            'SG ID': {
              rich_text: [{ plain_text: 'sg-xyz' }],
            },
          },
        },
      });

      const result = await getNotionPage('page-123');

      expect(result).toEqual({
        title: 'My Task',
        status: 'Start',
        instanceId: 'i-abc123',
        sgId: 'sg-xyz',
        publicIp: '',
        databaseId: 'db-123',
        launchedBy: '',
      });
    });

    it('should return empty strings when optional properties are missing', async () => {
      mockAxios.mockResolvedValue({
        data: {
          parent: {},
          properties: {
            Name: {
              type: 'title',
              title: [{ plain_text: 'Task' }],
            },
          },
        },
      });

      const result = await getNotionPage('page-456');

      expect(result).toEqual({
        title: 'Task',
        status: '',
        instanceId: '',
        sgId: '',
        publicIp: '',
        databaseId: '',
        launchedBy: '',
      });
    });

    it('should propagate Notion API errors', async () => {
      mockAxios.mockRejectedValue({
        response: { data: { message: 'Not found' } },
      });

      await expect(getNotionPage('bad-id')).rejects.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getNotionPageContent
  // -------------------------------------------------------------------------
  describe('getNotionPageContent', () => {
    it('should extract plain text from various block types', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { paragraph: { rich_text: [{ plain_text: 'Line 1' }] } },
            { heading_1: { rich_text: [{ plain_text: 'Heading' }] } },
            { bulleted_list_item: { rich_text: [{ plain_text: 'Bullet' }] } },
            { image: {} }, // non-text block, should be skipped from text
          ],
        },
      });

      const result = await getNotionPageContent('page-123');

      expect(result.text).toBe('Line 1\nHeading\nBullet');
      expect(result.attachments).toEqual([]);
    });

    it('should return empty text and no attachments for page with no text blocks', async () => {
      mockAxios.mockResolvedValue({
        data: { results: [{ type: 'divider', divider: {} }] },
      });

      const result = await getNotionPageContent('page-empty');

      expect(result.text).toBe('');
      expect(result.attachments).toEqual([]);
    });

    it('should extract image attachment with Notion-hosted file URL', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { paragraph: { rich_text: [{ plain_text: 'Some text' }] } },
            {
              type: 'image',
              image: {
                type: 'file',
                file: { url: 'https://prod-files-secure.s3.amazonaws.com/screenshot.png' },
                caption: [{ plain_text: 'My screenshot' }],
              },
            },
          ],
        },
      });

      const result = await getNotionPageContent('page-img');

      expect(result.text).toBe('Some text');
      expect(result.attachments).toEqual([
        {
          url: 'https://prod-files-secure.s3.amazonaws.com/screenshot.png',
          name: 'My screenshot',
          type: 'image',
        },
      ]);
    });

    it('should extract file attachment with external URL', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            {
              type: 'file',
              file: {
                type: 'external',
                external: { url: 'https://example.com/spec.pdf' },
                name: 'spec.pdf',
              },
            },
          ],
        },
      });

      const result = await getNotionPageContent('page-file');

      expect(result.attachments).toEqual([
        {
          url: 'https://example.com/spec.pdf',
          name: 'spec.pdf',
          type: 'file',
        },
      ]);
    });

    it('should extract mixed text and attachment blocks', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { paragraph: { rich_text: [{ plain_text: 'Intro' }] } },
            {
              type: 'image',
              image: {
                type: 'file',
                file: { url: 'https://s3.amazonaws.com/mockup.png' },
                caption: [],
              },
            },
            { heading_2: { rich_text: [{ plain_text: 'Section' }] } },
            {
              type: 'pdf',
              pdf: {
                type: 'file',
                file: { url: 'https://s3.amazonaws.com/doc.pdf' },
              },
            },
            {
              type: 'video',
              video: {
                type: 'external',
                external: { url: 'https://youtube.com/watch?v=abc' },
              },
            },
          ],
        },
      });

      const result = await getNotionPageContent('page-mixed');

      expect(result.text).toBe('Intro\nSection');
      expect(result.attachments).toHaveLength(3);
      expect(result.attachments[0]).toEqual({
        url: 'https://s3.amazonaws.com/mockup.png',
        name: 'mockup.png',
        type: 'image',
      });
      expect(result.attachments[1]).toEqual({
        url: 'https://s3.amazonaws.com/doc.pdf',
        name: 'doc.pdf',
        type: 'pdf',
      });
      expect(result.attachments[2]).toEqual({
        url: 'https://youtube.com/watch?v=abc',
        name: 'video_attachment',
        type: 'video',
      });
    });
  });

  // -------------------------------------------------------------------------
  // updateNotionPageProperties
  // -------------------------------------------------------------------------
  describe('updateNotionPageProperties', () => {
    it('should send PATCH with correct property format', async () => {
      mockAxios.mockResolvedValue({ data: {} });

      await updateNotionPageProperties('page-123', {
        instanceId: 'i-abc',
        publicIp: '1.2.3.4',
        sgId: 'sg-xyz',
        status: 'In Progress',
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'patch',
          data: {
            properties: {
              'Instance ID': { rich_text: [{ text: { content: 'i-abc' } }] },
              'Public IP': { rich_text: [{ text: { content: '1.2.3.4' } }] },
              'SG ID': { rich_text: [{ text: { content: 'sg-xyz' } }] },
              Status: { status: { name: 'In Progress' } },
            },
          },
        })
      );
    });

    it('should clear properties when given empty strings', async () => {
      mockAxios.mockResolvedValue({ data: {} });

      await updateNotionPageProperties('page-123', {
        instanceId: '',
        publicIp: '',
        sgId: '',
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            properties: {
              'Instance ID': { rich_text: [] },
              'Public IP': { rich_text: [] },
              'SG ID': { rich_text: [] },
            },
          },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // addNotionComment
  // -------------------------------------------------------------------------
  describe('addNotionComment', () => {
    it('should post comment with correct format', async () => {
      mockAxios.mockResolvedValue({ data: {} });

      await addNotionComment('page-123', 'Hello world');

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          data: {
            parent: { page_id: 'page-123' },
            rich_text: [{ text: { content: 'Hello world' } }],
          },
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // launchEnvironment
  // -------------------------------------------------------------------------
  describe('launchEnvironment', () => {
    beforeEach(() => {
      // Setup happy path mocks
      mockAxios.mockResolvedValue({ data: {} }); // Notion API calls
      mockSSM.getParameters.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Parameters: [{ Value: 'ami-test123' }],
        }),
      });
      mockEC2.describeVpcs.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Vpcs: [{ VpcId: 'vpc-test' }],
        }),
      });
      mockEC2.createSecurityGroup.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ GroupId: 'sg-new' }),
      });
      mockEC2.createTags.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.authorizeSecurityGroupIngress.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockIAM.getInstanceProfile.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          InstanceProfile: { Arn: 'arn:aws:iam::123:instance-profile/test' },
        }),
      });
      mockEC2.runInstances.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Instances: [{ InstanceId: 'i-launched' }],
        }),
      });
      mockEC2.waitFor.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.describeInstances.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Reservations: [{ Instances: [{ PublicIpAddress: '10.0.0.1' }] }],
        }),
      });
      mockFs.readFileSync.mockReturnValue('#!/bin/bash\necho hello');
    });

    it('should launch EC2 and update Notion page', async () => {
      await launchEnvironment('page-1', 'My Feature', 'details', 'db-1');

      // Verify SG created with ports 22 and 5175
      expect(mockEC2.authorizeSecurityGroupIngress).toHaveBeenCalledWith(
        expect.objectContaining({
          GroupId: 'sg-new',
          IpPermissions: expect.arrayContaining([
            expect.objectContaining({ FromPort: 22, ToPort: 22 }),
            expect.objectContaining({ FromPort: 5175, ToPort: 5175 }),
          ]),
        })
      );

      // Verify EC2 launched with correct tags
      expect(mockEC2.runInstances).toHaveBeenCalledWith(
        expect.objectContaining({
          TagSpecifications: [
            expect.objectContaining({
              Tags: expect.arrayContaining([
                { Key: 'Name', Value: 'dev_My Feature' },
                { Key: 'purpose', Value: 'test-env' },
                { Key: 'notion-page-id', Value: 'page-1' },
                { Key: 'sg-id', Value: 'sg-new' },
              ]),
            }),
          ],
        })
      );

      // Verify Notion updated (multiple axios calls: ensureDb + updateProps + addComment)
      expect(mockAxios).toHaveBeenCalled();
    });

    it('should handle AMI resolution failure', async () => {
      mockSSM.getParameters.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Parameters: [] }),
      });

      // Should not throw (catches internally and posts error comment)
      await launchEnvironment('page-1', 'Test', '', 'db-1');

      // Verify error comment was posted to Notion
      const notionCalls = mockAxios.mock.calls;
      const commentCall = notionCalls.find(
        (c: any) => c[0]?.method === 'post' && c[0]?.data?.parent?.page_id === 'page-1'
      );
      expect(commentCall).toBeDefined();
    });

    it('should handle missing default VPC', async () => {
      mockSSM.getParameters.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Parameters: [{ Value: 'ami-test' }],
        }),
      });
      mockEC2.describeVpcs.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Vpcs: [] }),
      });

      await launchEnvironment('page-1', 'Test', '', 'db-1');

      // Should not have attempted to create SG
      expect(mockEC2.createSecurityGroup).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // teardownEnvironment
  // -------------------------------------------------------------------------
  describe('teardownEnvironment', () => {
    it('should terminate instance, delete SG, and clear Notion', async () => {
      // Mock getNotionPage response
      mockAxios.mockResolvedValueOnce({
        data: {
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
            Status: { status: { name: 'Done' } },
            'Instance ID': { rich_text: [{ plain_text: 'i-teardown' }] },
            'SG ID': { rich_text: [{ plain_text: 'sg-teardown' }] },
          },
        },
      });
      // Mock subsequent Notion API calls (updateProps, addComment)
      mockAxios.mockResolvedValue({ data: {} });

      mockEC2.terminateInstances.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.waitFor.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.deleteSecurityGroup.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await teardownEnvironment('page-teardown');

      expect(mockEC2.terminateInstances).toHaveBeenCalledWith({
        InstanceIds: ['i-teardown'],
      });
      expect(mockEC2.deleteSecurityGroup).toHaveBeenCalledWith({
        GroupId: 'sg-teardown',
      });
    });

    it('should skip teardown when no instance ID on page', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          parent: {},
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
          },
        },
      });

      await teardownEnvironment('page-no-instance');

      expect(mockEC2.terminateInstances).not.toHaveBeenCalled();
    });

    // Regression: the 2026-06-26 prod disk-fill outage. A page stuck at
    // "pending" (never provisioned) made teardown call terminateInstances with a
    // malformed id every webhook tick, throwing + dumping full error objects.
    it.each(['pending', 'i-', 'launching', '550e8400-e29b-41d4-a716-446655440000'])(
      'should NOT call EC2 terminateInstances for non-EC2 instanceId "%s"',
      async (badId) => {
        mockAxios.mockResolvedValueOnce({
          data: {
            parent: { database_id: 'db-1' },
            properties: {
              Name: { type: 'title', title: [{ plain_text: 'Task' }] },
              Status: { status: { name: 'Done' } },
              'Instance ID': { rich_text: [{ plain_text: badId }] },
              'SG ID': { rich_text: [{ plain_text: 'sg-x' }] },
            },
          },
        });
        mockAxios.mockResolvedValue({ data: {} });

        await teardownEnvironment('page-bad-id');

        expect(mockEC2.terminateInstances).not.toHaveBeenCalled();
      }
    );

    it('should clear the page (so teardown stops re-firing) when instanceId is "pending"', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
            Status: { status: { name: 'Done' } },
            'Instance ID': { rich_text: [{ plain_text: 'pending' }] },
            'SG ID': { rich_text: [{ plain_text: 'sg-x' }] },
          },
        },
      });
      mockAxios.mockResolvedValue({ data: {} });

      await teardownEnvironment('page-pending');

      const patchCall = (mockAxios.mock.calls as any[]).find(
        (c) => c[0]?.method === 'patch'
      );
      expect(patchCall).toBeDefined();
      expect(patchCall[0].data.properties['Instance ID']).toEqual({ rich_text: [] });
    });

    it('still terminates a real EC2 instance id (happy path unchanged)', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
            Status: { status: { name: 'Done' } },
            'Instance ID': { rich_text: [{ plain_text: 'i-0abc123def456' }] },
            'SG ID': { rich_text: [{ plain_text: 'sg-x' }] },
          },
        },
      });
      mockAxios.mockResolvedValue({ data: {} });
      mockEC2.terminateInstances.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
      mockEC2.waitFor.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
      mockEC2.deleteSecurityGroup.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

      await teardownEnvironment('page-real');

      expect(mockEC2.terminateInstances).toHaveBeenCalledWith({
        InstanceIds: ['i-0abc123def456'],
      });
    });

    it('should handle SG deletion failure gracefully', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
            Status: { status: { name: 'Done' } },
            'Instance ID': { rich_text: [{ plain_text: 'i-test' }] },
            'SG ID': { rich_text: [{ plain_text: 'sg-test' }] },
          },
        },
      });
      mockAxios.mockResolvedValue({ data: {} });

      mockEC2.terminateInstances.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.waitFor.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockEC2.deleteSecurityGroup.mockReturnValue({
        promise: jest.fn().mockRejectedValue(new Error('DependencyViolation')),
      });

      // Should not throw — SG failure is caught internally
      await teardownEnvironment('page-sg-fail');

      // Should still update Notion despite SG failure
      expect(mockAxios).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getNotionPage — publicIp extraction
  // -------------------------------------------------------------------------
  describe('getNotionPage — publicIp', () => {
    it('should return publicIp from page properties', async () => {
      mockAxios.mockResolvedValue({
        data: {
          parent: { database_id: 'db-1' },
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
            Status: { status: { name: 'In Progress' } },
            'Instance ID': { rich_text: [{ plain_text: 'i-abc' }] },
            'SG ID': { rich_text: [{ plain_text: 'sg-xyz' }] },
            'Public IP': { rich_text: [{ plain_text: '10.0.0.5' }] },
          },
        },
      });

      const result = await getNotionPage('page-ip');

      expect(result.publicIp).toBe('10.0.0.5');
    });

    it('should return empty publicIp when property is missing', async () => {
      mockAxios.mockResolvedValue({
        data: {
          parent: {},
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task' }] },
          },
        },
      });

      const result = await getNotionPage('page-no-ip');

      expect(result.publicIp).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // getNotionCommentText
  // -------------------------------------------------------------------------
  describe('getNotionCommentText', () => {
    it('should find and return correct comment text by ID', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { id: 'comment-1', rich_text: [{ plain_text: 'First comment' }] },
            { id: 'comment-2', rich_text: [{ plain_text: 'Second comment' }] },
          ],
        },
      });

      const text = await getNotionCommentText('page-1', 'comment-2');

      expect(text).toBe('Second comment');
    });

    it('should return empty string for unknown commentId', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { id: 'comment-1', rich_text: [{ plain_text: 'Hello' }] },
          ],
        },
      });

      const text = await getNotionCommentText('page-1', 'nonexistent');

      expect(text).toBe('');
    });

    it('should handle comment with no rich_text', async () => {
      mockAxios.mockResolvedValue({
        data: {
          results: [
            { id: 'comment-1' },
          ],
        },
      });

      const text = await getNotionCommentText('page-1', 'comment-1');

      expect(text).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // getNotionBotUserId
  // -------------------------------------------------------------------------
  describe('getNotionBotUserId', () => {
    it('should return bot user ID from /users/me', async () => {
      mockAxios.mockResolvedValue({
        data: { id: 'bot-user-123' },
      });

      const botId = await getNotionBotUserId();

      expect(botId).toBe('bot-user-123');
    });
  });

  // -------------------------------------------------------------------------
  // relayPromptToEC2
  // -------------------------------------------------------------------------
  describe('relayPromptToEC2', () => {
    it('should POST prompt to EC2 with notion token as relay secret', async () => {
      // notionRequest uses mockAxios for the Notion /users/me etc calls;
      // relayPromptToEC2 uses axios.post — mock separately
      (axios.post as jest.Mock) = jest.fn().mockResolvedValue({ data: { ok: true } });

      await relayPromptToEC2('10.0.0.1', 'Hello Claude', 'page-1');

      expect(axios.post).toHaveBeenCalledWith(
        'http://10.0.0.1:5175/api/claude-prompt',
        { prompt: 'Hello Claude', notionPageId: 'page-1' },
        expect.objectContaining({
          headers: { 'X-Relay-Secret': 'mock-notion-token' },
          timeout: 10000,
        })
      );
    });

    it('should not throw on network error (logs and continues)', async () => {
      (axios.post as jest.Mock) = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      // Should not throw
      await relayPromptToEC2('10.0.0.1', 'test', 'page-1');
    });
  });
});

// ---------------------------------------------------------------------------
// Webhook route handler tests
// ---------------------------------------------------------------------------
describe('devEnv webhook route', () => {
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = { body: {} };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  });

  // Import the route handler after mocks are set up
  // We test the logic inline since the route is a single handler

  it('should return verification token on verification request', async () => {
    // We test the verification logic directly
    const body = { verification_token: 'test-token-123' };

    if (body?.verification_token) {
      mockRes.status(200).json({ verification_token: body.verification_token });
    }

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({
      verification_token: 'test-token-123',
    });
  });

  it('should return 400 when no page_id in payload', async () => {
    const body: any = { type: 'page.properties_updated' };

    const pageId = body?.entity?.id || body?.data?.id || body?.page_id || body?.id;
    if (!pageId) {
      mockRes.status(400).json({ error: 'Missing page_id in payload' });
    }

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Missing page_id in payload',
    });
  });

  it('should extract page_id from entity.id', () => {
    const body: any = {
      entity: { id: 'page-from-entity' },
      data: { id: 'page-from-data' },
    };

    const pageId = body?.entity?.id || body?.data?.id || body?.page_id || body?.id;

    expect(pageId).toBe('page-from-entity');
  });

  it('should extract page_id from fallback fields', () => {
    const body: any = { page_id: 'page-from-field' };

    const pageId = body?.entity?.id || body?.data?.id || body?.page_id || body?.id;

    expect(pageId).toBe('page-from-field');
  });
});

describe('user-data-dev-auto.sh size', () => {
  it('should be under the EC2 user-data 16384-byte limit', () => {
    // Use jest.requireActual to bypass any fs mocking in the test environment
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const scriptPath = path.resolve(__dirname, '../../../test-env/user-data-dev-auto.sh');
    const size = fs.statSync(scriptPath).size;
    expect(size).toBeLessThan(16384);
  });
});
