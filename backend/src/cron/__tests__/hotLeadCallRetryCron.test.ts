jest.mock('../../services/voice/hotLeadCallRetrySweep', () => ({ runHotLeadCallRetrySweep: jest.fn() }));

import { runHotLeadCallRetrySweep } from '../../services/voice/hotLeadCallRetrySweep';
import { HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS, HOT_LEAD_CALL_RETRY_INTERVAL_MS, resetHotLeadCallRetryCronForTests, startHotLeadCallRetryCron } from '../hotLeadCallRetryCron';

const sweep = runHotLeadCallRetrySweep as jest.Mock;
const idle = { enabled: true, killSwitchOn: true, orgs: 0, lists: 0, skippedLists: 0, leadsRead: 0, truncated: false, found: 0, notDue: 0, rescheduled: 0, attempted: 0, refused: 0, expired: 0, lost: 0, failed: 0 };

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  sweep.mockReset().mockResolvedValue(idle);
  resetHotLeadCallRetryCronForTests();
  delete process.env.HOT_LEAD_CALL_RETRY;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete process.env.HOT_LEAD_CALL_RETRY;
});

describe('startHotLeadCallRetryCron (what server.ts calls)', () => {
  const host = (enabled = true) => ({ enabled: jest.fn(() => enabled), track: jest.fn((_name: string, run: Promise<unknown>) => run) });

  it('runs once 30 seconds after arming (a fresh deploy does not wait 5 minutes), then every 5 minutes, through the host\'s registry', async () => {
    const h = host();
    const timer = startHotLeadCallRetryCron(h);
    expect(timer).not.toBeNull();
    expect(HOT_LEAD_CALL_RETRY_INTERVAL_MS).toBe(300_000);
    expect(HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS).toBe(30_000);
    await jest.advanceTimersByTimeAsync(HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('hotLeadCallRetryCron', expect.any(Promise));
    await jest.advanceTimersByTimeAsync(HOT_LEAD_CALL_RETRY_INTERVAL_MS - HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS - 1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(2); // the 5 minute tick
    await jest.advanceTimersByTimeAsync(HOT_LEAD_CALL_RETRY_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
    clearInterval(timer!);
  });

  it.each(['off', '0', 'false'])('arms nothing with HOT_LEAD_CALL_RETRY=%s', async (value) => {
    process.env.HOT_LEAD_CALL_RETRY = value;
    expect(startHotLeadCallRetryCron(host())).toBeNull();
    await jest.advanceTimersByTimeAsync(HOT_LEAD_CALL_RETRY_INTERVAL_MS * 3);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('does not run on a tick where the host says crons are off (isCronEnabled)', async () => {
    const h = host(false);
    const timer = startHotLeadCallRetryCron(h);
    await jest.advanceTimersByTimeAsync(HOT_LEAD_CALL_RETRY_INTERVAL_MS * 2);
    expect(h.enabled).toHaveBeenCalledTimes(3); // the boot run and two ticks
    expect(sweep).not.toHaveBeenCalled();
    clearInterval(timer!);
  });
});
