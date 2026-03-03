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
        sendInvitation: jest.fn().mockResolvedValue({ id: 'invitation-id' })
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
  });
});
