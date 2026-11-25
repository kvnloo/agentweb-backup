const mockPut = jest.fn();
jest.mock('aws-sdk', () => ({ DynamoDB: { DocumentClient: jest.fn(() => ({ put: mockPut })) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async () => ({ orgId: 'org-test' })) } }));
import { recordSuccessfulSend } from '../services/sentMessageShadow';
const input = { channel: 'email' as const, userId: 'user', recipients: ['test@example.com'], providerId: 'provider-test', adapter: 'test' };
const flush = () => new Promise(setImmediate);
describe('shadow records', () => {
  beforeEach(() => { delete process.env.SENT_MESSAGE_LEDGER_MODE; mockPut.mockReset(); mockPut.mockReturnValue({ promise: async () => ({}) }); });
  it('defaults to shadow, records successful sends without a claim', async () => {
    expect(recordSuccessfulSend(input)).toBeUndefined(); await flush();
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ Item: expect.objectContaining({ orgId: 'org-test', mode: 'shadow', status: 'sent', providerId: 'provider-test' }) }));
    expect(mockPut.mock.calls[0][0].ConditionExpression).toBeUndefined();
  });
  it('does not throw when recording fails', async () => {
    mockPut.mockReturnValue({ promise: async () => { throw new Error('offline'); } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(recordSuccessfulSend(input)).toBeUndefined(); await flush(); expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
  it('does not wait on a hung record', async () => {
    mockPut.mockReturnValue({ promise: () => new Promise(() => {}) });
    expect(recordSuccessfulSend(input)).toBeUndefined(); await flush(); expect(mockPut).toHaveBeenCalled();
  });
  it('off and enforce values cannot activate enforcement', async () => {
    for (const value of ['off', 'enforce']) { process.env.SENT_MESSAGE_LEDGER_MODE = value; recordSuccessfulSend(input); }
    await flush(); expect(mockPut).not.toHaveBeenCalled();
  });
});
