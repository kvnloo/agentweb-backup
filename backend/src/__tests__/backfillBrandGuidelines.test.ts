const scan = jest.fn();
const plan = jest.fn();
const apply = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan: (params: unknown) => ({ promise: () => scan(params) }),
      put: jest.fn(() => ({ promise: jest.fn() })),
      update: jest.fn(() => ({ promise: jest.fn() })),
    })),
  },
}));

jest.mock('../services/brandGuidelinesPopulation', () => ({
  planBrandGuidelinesPopulation: (...args: unknown[]) => plan(...args),
  applyBrandGuidelinesPopulation: (...args: unknown[]) => apply(...args),
}));

import { runBrandGuidelinesBackfill } from '../services/brandGuidelinesBackfill';

describe('backfill-brand-guidelines safety', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';
    scan.mockResolvedValue({ Items: [{ userId: 'u1' }, { userId: 'u2' }] });
    plan.mockImplementation(async (userId: string) => ({
      userId,
      emptyFields: userId === 'u1' ? ['tagline'] : [],
      filledFields: userId === 'u1' ? ['tagline'] : [],
      guidelines: { brandData: { tagline: 'Filled' } },
    }));
    apply.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    (console.log as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
  });

  it('dry-run inspects every account and performs zero writes', async () => {
    await runBrandGuidelinesBackfill([]);

    expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'Dev-AW-Users',
      ProjectionExpression: 'userId',
    }));
    expect(plan).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('1 distinct owners with fillable fields; no writes performed');
  });

  it('--apply replans immediately before one conditional population write', async () => {
    await runBrandGuidelinesBackfill(['--apply']);

    expect(plan.mock.calls.map(([userId]) => userId)).toEqual(['u1', 'u2', 'u1']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      filledFields: ['tagline'],
    }));
  });

  it('aborts all writes when any inspection fails', async () => {
    plan.mockRejectedValueOnce(new Error('malformed record'));

    await expect(runBrandGuidelinesBackfill(['--apply'])).rejects.toThrow('Inspection failed for 1 accounts; no writes performed');
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects unknown flags and ambiguous environments before scanning', async () => {
    await expect(runBrandGuidelinesBackfill(['--force'])).rejects.toThrow('Only --apply is supported');
    process.env.NODE_ENV = 'test';
    await expect(runBrandGuidelinesBackfill([])).rejects.toThrow('Set NODE_ENV explicitly');
    expect(scan).not.toHaveBeenCalled();
  });
});
