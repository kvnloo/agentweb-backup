// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('axios');
import axios from 'axios';

// slackService instantiates a Slack WebClient at import time (which reads
// axios.defaults). Because this suite auto-mocks axios, axios.defaults is
// undefined and the real WebClient constructor throws while the agentMode
// module graph loads. Stub slackService so the suite can load.
jest.mock('../services/slackService', () => ({}));

//Mock the dependencies
jest.mock('../services/metaService', () => ({
  metaService: {
    uploadImage: jest.fn(),
    uploadVideo: jest.fn(),
    listCustomAudiences: jest.fn(),
    createCustomAudience: jest.fn(),
    uploadCustomAudienceUsers: jest.fn(),
    searchTargeting: jest.fn()
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

describe('AgentModeService - Meta Upload and Advanced Operations', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  const mockUser = {
    id: 'user123',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: '123456789',
        account_name: 'Test Business',
        config: {
          account_type: 'ad_account',
          access_token: 'mock-access-token',
          ad_account_id: '123456789'
        }
      }
    ]
  };

  // ==================== UPLOAD OPERATIONS ====================
  describe('Upload Operations', () => {
    describe('uploadMetaAdsImage', () => {
      it('should successfully upload an image and surface a top-level image_hash', async () => {
        // metaService.uploadImage now returns a flat { hash, url } object.
        const mockImageData = { hash: 'image_hash_123', url: 'https://scontent.example/img.jpg' };
        const imageUrl = 'https://example.com/image.jpg';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadImage as jest.Mock).mockResolvedValue(mockImageData);
        (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('mock image data') });

        const result = await agentModeService.uploadMetaAdsImage('user123', imageUrl);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Image uploaded successfully');
        expect(result.image_hash).toBe('image_hash_123');
        expect(result.image_url).toBe('https://scontent.example/img.jpg');
        expect(result.image).toEqual(mockImageData);
      });

      it('should fail clearly when Meta returns no hash', async () => {
        const imageUrl = 'https://example.com/image.jpg';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadImage as jest.Mock).mockResolvedValue({ url: 'https://no-hash.example' });
        (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('mock image data') });

        const result = await agentModeService.uploadMetaAdsImage('user123', imageUrl);

        expect(result.success).toBe(false);
        expect(result.error).toBe('NO_IMAGE_HASH');
      });

      it('should return distinct hashes for distinct images (no scrambling)', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('mock image data') });
        (metaService.uploadImage as jest.Mock)
          .mockResolvedValueOnce({ hash: 'hash_A' })
          .mockResolvedValueOnce({ hash: 'hash_B' })
          .mockResolvedValueOnce({ hash: 'hash_C' });

        const a = await agentModeService.uploadMetaAdsImage('user123', 'https://example.com/a.png');
        const b = await agentModeService.uploadMetaAdsImage('user123', 'https://example.com/b.png');
        const c = await agentModeService.uploadMetaAdsImage('user123', 'https://example.com/c.png');

        expect([a.image_hash, b.image_hash, c.image_hash]).toEqual(['hash_A', 'hash_B', 'hash_C']);
        expect(new Set([a.image_hash, b.image_hash, c.image_hash]).size).toBe(3);
      });

      it('should handle download errors', async () => {
        const imageUrl = 'https://example.com/image.jpg';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (axios.get as jest.Mock).mockRejectedValue(new Error('Failed to download image'));

        const result = await agentModeService.uploadMetaAdsImage('user123', imageUrl);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to download image');
      });

      it('should handle upload errors', async () => {
        const imageUrl = 'https://example.com/image.jpg';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('image data') });
        (metaService.uploadImage as jest.Mock).mockRejectedValue(new Error('Invalid image format'));

        const result = await agentModeService.uploadMetaAdsImage('user123', imageUrl);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Invalid image format');
      });

      it('should surface Meta structured error details instead of a bare message', async () => {
        const imageUrl = 'https://example.com/oversized.png';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('image data') });

        // Simulate metaService.handleError attaching a structuredError to the thrown error.
        const err: any = new Error('Invalid parameter');
        err.structuredError = {
          code: 100,
          error_subcode: 1487837,
          error_user_title: 'Image too large',
          error_user_msg: 'The image dimensions exceed the maximum allowed.',
          classification: 'VALIDATION_ERROR',
        };
        (metaService.uploadImage as jest.Mock).mockRejectedValue(err);

        const result = await agentModeService.uploadMetaAdsImage('user123', imageUrl);

        expect(result.success).toBe(false);
        // The user-facing reason should be appended to the generic message.
        expect(result.message).toContain('The image dimensions exceed the maximum allowed.');
        expect(result.meta_error).toEqual({
          code: 100,
          error_subcode: 1487837,
          error_user_title: 'Image too large',
          error_user_msg: 'The image dimensions exceed the maximum allowed.',
          classification: 'VALIDATION_ERROR',
        });
      });
    });

    describe('uploadMetaAdsVideo', () => {
      it('should successfully upload a video', async () => {
        const mockVideoData = { id: 'video_123' };
        const videoUrl = 'https://example.com/video.mp4';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadVideo as jest.Mock).mockResolvedValue(mockVideoData);

        const result = await agentModeService.uploadMetaAdsVideo('user123', videoUrl);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Video "https://example.com/video.mp4" uploaded successfully');
        expect(result.video).toEqual(mockVideoData);
        expect(metaService.uploadVideo).toHaveBeenCalledWith('123456789', 'mock-access-token', videoUrl);
      });

      it('should handle errors', async () => {
        const videoUrl = 'https://example.com/video.mp4';

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadVideo as jest.Mock).mockRejectedValue(new Error('File too large'));

        const result = await agentModeService.uploadMetaAdsVideo('user123', videoUrl);

        expect(result.success).toBe(false);
        expect(result.message).toBe('File too large');
      });

      it('should use specified account_id when provided', async () => {
        const multiAccountUser = {
          id: 'user123',
          connected_accounts: [
            {
              platform: 'meta',
              account_id: '123456789',
              account_name: 'Account 1',
              config: {
                account_type: 'ad_account',
                access_token: 'token1',
                ad_account_id: '123456789'
              }
            },
            {
              platform: 'meta',
              account_id: '987654321',
              account_name: 'Account 2',
              config: {
                account_type: 'ad_account',
                access_token: 'token2',
                ad_account_id: '987654321'
              }
            }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(multiAccountUser);
        (metaService.uploadVideo as jest.Mock).mockResolvedValue({ id: 'video_123' });

        await agentModeService.uploadMetaAdsVideo('user123', 'https://example.com/video.mp4', '987654321');

        expect(metaService.uploadVideo).toHaveBeenCalledWith('987654321', 'token2', 'https://example.com/video.mp4');
      });
    });
  });

  // ==================== CUSTOM AUDIENCE OPERATIONS ====================
  describe('Custom Audience Operations', () => {
    describe('manageMetaCustomAudiences - list', () => {
      it('should successfully list custom audiences', async () => {
        const mockAudiences = [
          { id: 'audience_1', name: 'Audience 1', subtype: 'CUSTOM' },
          { id: 'audience_2', name: 'Audience 2', subtype: 'LOOKALIKE' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.listCustomAudiences as jest.Mock).mockResolvedValue(mockAudiences);

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'LIST', '123456789', {});

        expect(result.success).toBe(true);
        expect(result.message).toBe('Found 2 custom audience(s)');
        expect(result.audiences).toEqual(mockAudiences);
      });
    });

    describe('manageMetaCustomAudiences - create', () => {
      it('should successfully create a custom audience', async () => {
        const mockAudienceData = { id: 'audience_123', name: 'My Custom Audience' };
        const params = {
          action: 'create',
          name: 'My Custom Audience',
          subtype: 'CUSTOM',
          description: 'Test audience',
          customer_file_source: 'USER_PROVIDED_ONLY'
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createCustomAudience as jest.Mock).mockResolvedValue(mockAudienceData);

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'CREATE', '123456789', params);

        expect(result.success).toBe(true);
        expect(result.message).toBe('Custom Audience "My Custom Audience" created successfully');
        expect(result.audience).toEqual(mockAudienceData);
      });

      it('should create a lookalike audience with proper spec', async () => {
        const mockAudienceData = { id: 'audience_lookalike', name: 'Lookalike Audience' };
        const params = {
          action: 'create',
          name: 'Lookalike Audience',
          subtype: 'LOOKALIKE',
          lookalike_spec: {
            ratio: 0.01,
            origin: [{ id: 'source_audience_123' }],
            country: 'US'
          }
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createCustomAudience as jest.Mock).mockResolvedValue(mockAudienceData);

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'CREATE', '123456789', params);

        expect(result.success).toBe(true);
        expect(metaService.createCustomAudience).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          expect.objectContaining({
            name: 'Lookalike Audience',
            subtype: 'LOOKALIKE',
            lookalike_spec: expect.objectContaining({
              ratio: 0.01,
              country: 'US'
            })
          })
        );
      });

      // ENG-600: real live-test finding — Meta's raw error.message ("Permissions
      // error") was surfacing to the user with no way to act on it. The SDK
      // attaches a friendlier error_user_msg (with the exact accept-terms URL)
      // via structuredError; prefer that when present.
      it('surfaces the friendly error_user_msg (with accept-terms URL) instead of the generic SDK message', async () => {
        const sdkError: any = new Error('Permissions error');
        sdkError.structuredError = {
          message: 'Permissions error',
          code: 200,
          error_subcode: 1870090,
          error_user_title: 'Custom audience terms not accepted',
          error_user_msg: 'Custom audience terms not accepted. To create or edit an audience with an uploaded customer list, agree to the custom audience terms at https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456789.',
          classification: 'PERMISSION_ERROR',
        };
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createCustomAudience as jest.Mock).mockRejectedValue(sdkError);

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'CREATE', '123456789', {
          action: 'create', name: 'X', subtype: 'CUSTOM',
        });

        expect(result.success).toBe(false);
        expect(result.message).toContain('agree to the custom audience terms at https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456789');
        expect(result.message).toContain('one-time setup');
      });

      it('falls back to error.message when no structuredError is present', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.createCustomAudience as jest.Mock).mockRejectedValue(new Error('Network timeout'));

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'CREATE', '123456789', {
          action: 'create', name: 'X', subtype: 'CUSTOM',
        });

        expect(result.success).toBe(false);
        expect(result.message).toBe('Network timeout');
      });
    });

    describe('manageMetaCustomAudiences - upload_users', () => {
      it('should successfully upload users to custom audience', async () => {
        const params = {
          action: 'upload_users',
          audience_id: 'audience_123',
          schema: ['EMAIL', 'PHONE'],
          payload: 'email1@example.com,+1234567890\nemail2@example.com,+9876543210'
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadCustomAudienceUsers as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'UPLOAD_USERS', '123456789', { id: params.audience_id, schema: params.schema, payload: params.payload });

        expect(result.success).toBe(true);
        expect(result.message).toBe('Successfully initiated user upload to audience audience_123');
      });

      // ENG-600 known gap, now fixed: the naive split(',') parser mis-splits
      // any quoted field containing a comma (e.g. a phone value with an
      // extension, "555-5678, ext. 2"), silently corrupting column alignment
      // instead of parsing it as one field.
      it('correctly parses a quoted field containing a comma (real-world CSV export)', async () => {
        const params = {
          action: 'upload_users',
          audience_id: 'audience_123',
          schema: ['EMAIL', 'PHONE'],
          payload: 'john@example.com,"555-1234"\njane@example.com,"555-5678, ext. 2"',
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadCustomAudienceUsers as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'UPLOAD_USERS', '123456789', {
          id: params.audience_id, schema: params.schema, payload: params.payload,
        });

        expect(result.success).toBe(true);
        const [, , , , hashedPayload] = (metaService.uploadCustomAudienceUsers as jest.Mock).mock.calls[0];
        // Each row must still resolve to exactly 2 columns (email, phone) —
        // the naive parser would have split row 2 into 3 columns and thrown
        // a schema-mismatch error instead of reaching this point at all.
        expect(hashedPayload).toHaveLength(2);
        expect(hashedPayload[0]).toHaveLength(2);
        expect(hashedPayload[1]).toHaveLength(2);
      });

      it('should handle array payload', async () => {
        const params = {
          action: 'upload_users',
          audience_id: 'audience_123',
          schema: ['EMAIL'],
          payload: [['email1@example.com'], ['email2@example.com']]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadCustomAudienceUsers as jest.Mock).mockResolvedValue({ success: true });

        const result = await agentModeService.manageMetaCustomAudiences('user123', 'UPLOAD_USERS', '123456789', { id: params.audience_id, schema: params.schema, payload: params.payload });

        expect(result.success).toBe(true);
        // Note: emails are hashed before being sent to metaService
        expect(metaService.uploadCustomAudienceUsers).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          'audience_123',
          ['EMAIL'],
          expect.arrayContaining([
            expect.arrayContaining([expect.any(String)]),
            expect.arrayContaining([expect.any(String)])
          ])
        );
      });

      // ENG-600: the two new HubSpot/CSV audience-sourcing workflows pass an
      // uploaded CSV attachment's URL straight through as `payload` — this
      // locks in that the existing URL-detection/fetch path actually works
      // before relying on it, rather than assuming.
      it('fetches and parses a CSV payload from an https:// URL', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.uploadCustomAudienceUsers as jest.Mock).mockResolvedValue({ success: true });
        (axios.get as jest.Mock).mockResolvedValue({
          data: 'email1@example.com,+1234567890\nemail2@example.com,+9876543210',
        });

        const result = await agentModeService.manageMetaCustomAudiences(
          'user123',
          'UPLOAD_USERS',
          '123456789',
          { id: 'audience_123', schema: ['EMAIL', 'PHONE'], payload: 'https://s3.example.com/uploads/audience.csv' }
        );

        expect(axios.get).toHaveBeenCalledWith('https://s3.example.com/uploads/audience.csv');
        expect(result.success).toBe(true);
        expect(metaService.uploadCustomAudienceUsers).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          'audience_123',
          ['EMAIL', 'PHONE'],
          [
            [expect.any(String), expect.any(String)],
            [expect.any(String), expect.any(String)],
          ]
        );
      });

      it('surfaces an error when the CSV payload URL fails to fetch', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (axios.get as jest.Mock).mockRejectedValue(new Error('Network timeout'));

        const result = await agentModeService.manageMetaCustomAudiences(
          'user123',
          'UPLOAD_USERS',
          '123456789',
          { id: 'audience_123', schema: ['EMAIL'], payload: 'https://s3.example.com/uploads/missing.csv' }
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to fetch CSV content from URL');
        expect(metaService.uploadCustomAudienceUsers).not.toHaveBeenCalled();
      });
    });

    it('should return error for invalid action', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService.manageMetaCustomAudiences('user123', 'INVALID_ACTION' as any, '123456789', {});

      expect(result.success).toBe(false);
      expect(result.message).toContain('Action INVALID_ACTION is not supported');
    });
  });

  // ==================== TARGETING OPERATIONS ====================
  describe('Targeting Operations', () => {
    describe('searchAdTargeting', () => {
      it('should successfully search for targeting options', async () => {
        const mockResults = [
          { id: '123', name: 'Marketing', type: 'adinterest' },
          { id: '456', name: 'Digital Marketing', type: 'adinterest' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.searchTargeting as jest.Mock).mockResolvedValue(mockResults);

        const result = await agentModeService.searchAdTargeting('user123', '123456789', 'marketing', 'adinterest');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Found 2 results');
        expect(result.data).toEqual(mockResults);
        expect(metaService.searchTargeting).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          'marketing',
          'adinterest',
          undefined
        );
      });

      it('should search for behaviors with class parameter', async () => {
        const mockResults = [
          { id: '789', name: 'Frequent Travelers', type: 'behaviors' }
        ];

        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.searchTargeting as jest.Mock).mockResolvedValue(mockResults);

        const result = await agentModeService.searchAdTargeting('user123', '123456789', 'travel', 'behaviors');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
      });

      it('should handle empty results', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.searchTargeting as jest.Mock).mockResolvedValue([]);

        const result = await agentModeService.searchAdTargeting('user123', '123456789', 'nonexistent', 'adinterest');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Found 0 results');
        expect(result.data).toEqual([]);
      });

      it('should handle errors', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.searchTargeting as jest.Mock).mockRejectedValue(new Error('Invalid search type'));

        const result = await agentModeService.searchAdTargeting('user123', '123456789', 'test', 'invalid_type');

        expect(result.success).toBe(false);
        expect(result.message).toBe('Invalid search type');
      });

      it('should use specified account_id when provided', async () => {
        const multiAccountUser = {
          id: 'user123',
          connected_accounts: [
            {
              platform: 'meta',
              account_id: '123456789',
              account_name: 'Account 1',
              config: {
                account_type: 'ad_account',
                access_token: 'token1',
                ad_account_id: '123456789'
              }
            },
            {
              platform: 'meta',
              account_id: '987654321',
              account_name: 'Account 2',
              config: {
                account_type: 'ad_account',
                access_token: 'token2',
                ad_account_id: '987654321'
              }
            }
          ]
        };

        (userDb.getUserById as jest.Mock).mockResolvedValue(multiAccountUser);
        (metaService.searchTargeting as jest.Mock).mockResolvedValue([]);

        await agentModeService.searchAdTargeting('user123', '987654321', 'test', 'adinterest');

        expect(metaService.searchTargeting).toHaveBeenCalledWith('987654321', 'token2', 'test', 'adinterest', undefined);
      });

      it('should forward location_types to metaService.searchTargeting for adgeolocation', async () => {
        (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
        (metaService.searchTargeting as jest.Mock).mockResolvedValue([]);

        await agentModeService.searchAdTargeting('user123', '123456789', 'San Jose', 'adgeolocation', ['city']);

        expect(metaService.searchTargeting).toHaveBeenCalledWith(
          '123456789',
          'mock-access-token',
          'San Jose',
          'adgeolocation',
          ['city']
        );
      });
    });
  });
});
