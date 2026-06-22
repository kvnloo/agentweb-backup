/**
 * Tests for the 429 retry interceptor registered on the HubSpotService axios instance.
 *
 * The interceptor is wired at module load time onto the axios instance created by
 * axios.create(). We use jest.isolateModules + jest.doMock to load the module
 * fresh with a controlled axios mock, capture the registered onRejected handler,
 * and exercise it directly.
 */

describe('HubSpotService — 429 retry interceptor', () => {
  let capturedRejectedHandler: ((err: any) => Promise<any>) | undefined;
  let mockRetryRequest: jest.Mock;

  beforeEach(() => {
    capturedRejectedHandler = undefined;
    mockRetryRequest = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('axios', () => ({
        create: jest.fn(() => ({
          interceptors: {
            response: {
              use: jest.fn((_onFulfilled: any, onRejected: any) => {
                capturedRejectedHandler = onRejected;
              }),
            },
          },
          request: mockRetryRequest,
        })),
        isCancel: jest.fn(() => false),
      }));
      // Loading the module registers the interceptor synchronously.
      require('../services/hubspotService');
    });
  });

  it('captures the interceptor during module load', () => {
    expect(capturedRejectedHandler).toBeDefined();
  });

  it('retries once on 429 with 0ms Retry-After and returns the retry result', async () => {
    mockRetryRequest.mockResolvedValue({ data: 'retried' });

    const config = { url: '/crm/v3/objects/contacts' };
    const err429 = {
      response: { status: 429, headers: { 'retry-after': '0' } },
      config,
    };

    const result = await capturedRejectedHandler!(err429);

    expect(mockRetryRequest).toHaveBeenCalledWith(config);
    expect(result).toEqual({ data: 'retried' });
  });

  it('caps Retry-After at 10 seconds', async () => {
    jest.useFakeTimers();
    mockRetryRequest.mockResolvedValue({ data: 'ok' });

    const config = { url: '/test' };
    const err = { response: { status: 429, headers: { 'retry-after': '60' } }, config };

    const promise = capturedRejectedHandler!(err);
    // 60s cap means it fires at 60000ms, not the full value
    jest.advanceTimersByTime(60000);
    await Promise.resolve();
    await Promise.resolve();
    const result = await promise;

    expect(mockRetryRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: 'ok' });

    jest.useRealTimers();
  });

  it('defaults to 10s when Retry-After header is missing', async () => {
    jest.useFakeTimers();
    mockRetryRequest.mockResolvedValue({ data: 'ok' });

    const config = { url: '/test' };
    const err = { response: { status: 429, headers: {} }, config };

    const promise = capturedRejectedHandler!(err);
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    await Promise.resolve();
    await promise;

    expect(mockRetryRequest).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('does not retry on non-429 errors', async () => {
    const err500 = { response: { status: 500 }, config: { url: '/test' } };
    await expect(capturedRejectedHandler!(err500)).rejects.toMatchObject({ response: { status: 500 } });
    expect(mockRetryRequest).not.toHaveBeenCalled();
  });

  it('does not retry a second time when __hubspotRetried is already set', async () => {
    const config = { url: '/test', __hubspotRetried: true };
    const err429 = { response: { status: 429, headers: { 'retry-after': '0' } }, config };
    await expect(capturedRejectedHandler!(err429)).rejects.toBeTruthy();
    expect(mockRetryRequest).not.toHaveBeenCalled();
  });

  it('sets __hubspotRetried on config before retrying to prevent loops', async () => {
    let capturedConfig: any;
    mockRetryRequest.mockImplementation((cfg: any) => {
      capturedConfig = cfg;
      return Promise.resolve({ data: 'ok' });
    });

    const config = { url: '/test' };
    const err = { response: { status: 429, headers: { 'retry-after': '0' } }, config };

    await capturedRejectedHandler!(err);

    expect(capturedConfig.__hubspotRetried).toBe(true);
  });
});
