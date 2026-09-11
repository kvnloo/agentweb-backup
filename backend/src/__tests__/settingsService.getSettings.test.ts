const mockBatchGet = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      batchGet: (params: any) => ({ promise: () => mockBatchGet(params) }),
    })),
  },
}));

import { SettingsService } from '../services/settingsService';

describe('SettingsService.getSettings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('dispatches bounded BatchGet chunks concurrently', async () => {
    const pending: Array<(value: any) => void> = [];
    mockBatchGet.mockImplementation(() => new Promise(resolve => pending.push(resolve)));

    const resultPromise = new SettingsService().getSettings(
      Array.from({ length: 308 }, (_, index) => `replay_sessions_user-${index}`),
    );
    await Promise.resolve();

    expect(mockBatchGet).toHaveBeenCalledTimes(4);
    expect(mockBatchGet.mock.calls.map(([params]) =>
      params.RequestItems['AW-Settings'].Keys.length,
    )).toEqual([100, 100, 100, 8]);

    pending.forEach((resolve, index) => resolve({
      Responses: {
        'AW-Settings': [{
          settingName: `replay_sessions_user-${index}`,
          settingValue: `value-${index}`,
        }],
      },
    }));

    await expect(resultPromise).resolves.toHaveLength(4);
  });

  it('retries unprocessed keys and returns their settings', async () => {
    mockBatchGet
      .mockResolvedValueOnce({
        Responses: { 'AW-Settings': [] },
        UnprocessedKeys: {
          'AW-Settings': {
            Keys: [{ settingName: 'replay_sessions_user-1' }],
            ProjectionExpression: 'settingName, settingValue',
          },
        },
      })
      .mockResolvedValueOnce({
        Responses: {
          'AW-Settings': [{
            settingName: 'replay_sessions_user-1',
            settingValue: 'https://replay.example/user-1',
          }],
        },
      });

    await expect(new SettingsService().getSettings([
      'replay_sessions_user-1',
    ])).resolves.toEqual([{
      settingName: 'replay_sessions_user-1',
      settingValue: 'https://replay.example/user-1',
    }]);

    expect(mockBatchGet).toHaveBeenCalledTimes(2);
    expect(mockBatchGet.mock.calls[1][0].RequestItems['AW-Settings'].Keys).toEqual([
      { settingName: 'replay_sessions_user-1' },
    ]);
  });
});
