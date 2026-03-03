import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';

jest.mock('unipile-node-sdk');
jest.mock('../utils/secretsManager');
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

const mockGetUnipileCredentials = getUnipileCredentials as jest.MockedFunction<typeof getUnipileCredentials>;

describe('LinkedInOutreachService', () => {
  let mockUnipileClient: jest.Mocked<UnipileClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset the internal cached credentials to ensure isolated tests
    // using ts-ignore because they are private properties
    // @ts-ignore
    linkedInOutreachService.cachedDsn = null;
    // @ts-ignore
    linkedInOutreachService.cachedApiKey = null;
    // @ts-ignore
    linkedInOutreachService.client = null;

    mockGetUnipileCredentials.mockResolvedValue({
      dsn: 'api.unipile.com',
      apiKey: 'test-api-key'
    });

    // Setup mock UnipileClient
    mockUnipileClient = {
      users: {
        sendInvitation: jest.fn().mockResolvedValue({ id: 'invitation-id' }),
        getProfile: jest.fn().mockResolvedValue({ network_distance: 'SECOND_DEGREE', is_open_profile: false })
      },
      messaging: {
        startNewChat: jest.fn().mockResolvedValue({ id: 'chat-id' })
      },
      request: {
        send: jest.fn().mockResolvedValue({ provider_id: 'provider-123' })
      }
    } as unknown as jest.Mocked<UnipileClient>;

    (UnipileClient as jest.Mock).mockImplementation(() => mockUnipileClient);
  });

  describe('credentials caching', () => {
    it('should cache credentials and not call getUnipileCredentials on subsequent calls', async () => {
      // First call should fetch credentials
      await linkedInOutreachService.getClient();
      expect(mockGetUnipileCredentials).toHaveBeenCalledTimes(1);
      
      // Second call should use cached client/credentials
      await linkedInOutreachService.getClient();
      expect(mockGetUnipileCredentials).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should normalize the DSN to include https://', async () => {
      mockGetUnipileCredentials.mockResolvedValueOnce({
        dsn: 'api.unipile.com', // no protocol
        apiKey: 'test-api-key'
      });
      const url = await linkedInOutreachService.getApiUrl();
      expect(url).toBe('https://api.unipile.com');
    });
  });

  describe('sendInvitation', () => {
    it('should send an invitation without a default message if none is provided', async () => {
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'provider-id',
        message: undefined // verifies that no default message is added
      });
    });

    it('should send an invitation with the provided message', async () => {
      const customMessage = 'Hey, let us connect!';
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, customMessage);

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'provider-id',
        message: customMessage
      });
    });

    it('should reject with a helpful error when target is already a 1st-degree connection', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'FIRST_DEGREE',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false)
      ).rejects.toThrow('already connected');

      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('should send invitation when target is SECOND_DEGREE (not yet connected)', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'SECOND_DEGREE',
        is_open_profile: false
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should send invitation when target is OUT_OF_NETWORK', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'OUT_OF_NETWORK',
        is_open_profile: false
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should throw with human-readable message (not SDK class name) when Unipile returns already_invited_recently', async () => {
      const unipileError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: {
          status: 422,
          type: 'errors/already_invited_recently',
          title: 'Should delay new invitation to this recipient',
          detail: 'An invitation has already been sent recently to this recipient. Please try again later.'
        }
      });
      (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValue(unipileError);

      const thrown = await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false).catch(e => e);
      expect(thrown.message).toBe('Should delay new invitation to this recipient');
      expect(thrown.message).not.toBe('UnsuccessfulRequestError');
      expect((thrown as any).structuredError).toBeDefined();
    });
  });

  describe('sendMessage', () => {
    it('should reject with a helpful error when target is SECOND_DEGREE connection', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'SECOND_DEGREE',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should reject with a helpful error when target is OUT_OF_NETWORK', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'OUT_OF_NETWORK',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should reject with a helpful error when target is THIRD_DEGREE connection', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'THIRD_DEGREE',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should send message successfully when target is FIRST_DEGREE connection', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'FIRST_DEGREE',
        is_open_profile: false
      });

      const result = await linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!');

      expect(mockUnipileClient.messaging.startNewChat).toHaveBeenCalledWith({
        account_id: 'account-id',
        attendees_ids: ['provider-id'],
        text: 'Hello!'
      });
      expect(result).toEqual({ id: 'chat-id' });
    });

    it('should send message successfully when target has open profile (SECOND_DEGREE but is_open_profile=true)', async () => {
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'SECOND_DEGREE',
        is_open_profile: true
      });

      const result = await linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!');

      expect(mockUnipileClient.messaging.startNewChat).toHaveBeenCalledWith({
        account_id: 'account-id',
        attendees_ids: ['provider-id'],
        text: 'Hello!'
      });
      expect(result).toEqual({ id: 'chat-id' });
    });

    it('should surface a helpful error when startNewChat returns no_connection_with_recipient (pre-flight bypass)', async () => {
      // Simulate pre-flight check incorrectly passing but API rejecting
      (mockUnipileClient.users.getProfile as jest.Mock).mockResolvedValue({
        network_distance: 'FIRST_DEGREE',
        is_open_profile: false
      });
      const unipileError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: {
          status: 422,
          type: 'errors/no_connection_with_recipient',
          title: 'Recipient cannot be reached',
          detail: 'The recipient appears not to be first degree connection.'
        }
      });
      (mockUnipileClient.messaging.startNewChat as jest.Mock).mockRejectedValue(unipileError);

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');
    });
  });
});
