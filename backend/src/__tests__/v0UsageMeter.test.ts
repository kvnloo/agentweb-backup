const mockRecordVendorUsage = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...args: unknown[]) => mockRecordVendorUsage(...args),
}));

import { runMeteredV0Attempt, withV0ActingUser } from '../services/v0UsageMeter';

describe('runMeteredV0Attempt', () => {
  beforeEach(() => mockRecordVendorUsage.mockClear());

  it('preserves the vendor result', async () => {
    await expect(runMeteredV0Attempt(
      { ownerUserId: 'owner-1', operation: 'generate' },
      async () => ({ id: 'chat-1' }),
    )).resolves.toEqual({ id: 'chat-1' });
  });

  it('keeps every v0 chat SDK call behind the metered-attempt seam', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/v0Service.ts'), 'utf8');
    const sdkCalls = [...source.matchAll(/v0\.chats\.(?:create|sendMessage)\s*\(/g)];

    expect(sdkCalls).toHaveLength(9);
    for (const call of sdkCalls) {
      const prefix = source.slice(Math.max(0, call.index! - 250), call.index);
      expect(prefix).toMatch(/runMeteredV0Attempt\s*\(/);
    }
  });

  it('records the acting user and accountable owner at the allocated v0 rate', async () => {
    await runMeteredV0Attempt(
      { actingUserId: 'member-1', ownerUserId: 'owner-1', operation: 'generate', sessionId: 'session-1' },
      async () => ({ id: 'chat-1' }),
    );

    expect(mockRecordVendorUsage).toHaveBeenCalledWith({
      userId: 'member-1',
      billingUserId: 'owner-1',
      provider: 'v0',
      operation: 'generate',
      feature: 'landing_page_generation',
      unit: 'generation',
      quantity: 1,
      costUsd: 2,
      costSource: 'allocated',
      sessionId: 'session-1',
    });
  });

  it('records every attempted vendor request, including a rejected attempt', async () => {
    const error = new Error('HTTP 500');
    await expect(runMeteredV0Attempt(
      { ownerUserId: 'owner-1', operation: 'correction' },
      async () => { throw error; },
    )).rejects.toBe(error);

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the accountable owner when no distinct acting user exists', async () => {
    await runMeteredV0Attempt(
      { ownerUserId: 'owner-1', operation: 'iterate' },
      async () => ({ id: 'message-1' }),
    );

    expect(mockRecordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      billingUserId: 'owner-1',
    }));
  });

  it('inherits the request actor without replacing the accountable page owner', async () => {
    await withV0ActingUser('member-2', () => runMeteredV0Attempt(
      { ownerUserId: 'owner-2', operation: 'iterate' },
      async () => ({ id: 'message-2' }),
    ));

    expect(mockRecordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'member-2',
      billingUserId: 'owner-2',
    }));
  });
});
import fs from 'fs';
import path from 'path';
