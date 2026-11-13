/**
 * ENG-2743: a scheduled run whose daily cost jumps against its own recent history reaches oncall in one
 * daily digest; normal days, cheap schedules and new schedules page nobody.
 */
jest.mock('../../services/usageRecordDb', () => ({ usageRecordDb: { scanByDateRange: jest.fn() } }));
jest.mock('../../services/emailService', () => ({ emailService: { sendOncallEmailOnly: jest.fn(async () => true) } }));

import type { UsageRecordRow } from '../../services/usageRecordDb';
import { emailService } from '../../services/emailService';
import {
  findScheduleCostJumps,
  median,
  resetScheduleCostJumpDedupe,
  runScheduleCostJumpCheck,
  scheduleCostJumpTick,
  SCHEDULE_COST_JUMP_SEND_HOUR_UTC,
  totalsBySchedule,
  utcDay,
} from '../scheduleCostJumpCron';

const alert = emailService.sendOncallEmailOnly as jest.Mock;
const NOW = Date.parse('2026-11-12T06:00:00.000Z'); // evaluated day = 2026-11-11
const DAY = '2026-11-11';

let seq = 0;
function row(scheduleId: string, date: string, costUsd: number, calls = 10, extra: Partial<UsageRecordRow> = {}): UsageRecordRow {
  seq += 1;
  return {
    userId: 'u1',
    sk: `${date}#gemini-3.8-flash#agent_task:scheduled:${scheduleId}#${seq}`,
    date,
    model: 'gemini-3.8-flash',
    feature: `agent_task:scheduled:${scheduleId}`,
    costMicroUsd: Math.round(costUsd * 1e6),
    callCount: calls,
    billingUserId: 'owner-1',
    updatedAt: `${date}T23:00:00.000Z`,
    ttl: 0,
    ...extra,
  };
}
/** One row per day for the 7 days before DAY, each costing `usd`. */
function history(scheduleId: string, usd: number, days = 7): UsageRecordRow[] {
  return Array.from({ length: days }, (_, i) => row(scheduleId, utcDay(Date.parse(`${DAY}T00:00:00Z`), -(i + 1)), usd));
}

beforeEach(() => { alert.mockClear(); alert.mockResolvedValue(true); resetScheduleCostJumpDedupe(); });

describe('findScheduleCostJumps', () => {
  it('flags a schedule that cost at least 2x its baseline median and at least $3', () => {
    const rows = [...history('a', 5.6), row('a', DAY, 12.6, 231)];
    const [j, ...rest] = findScheduleCostJumps(rows, DAY);
    expect(rest).toHaveLength(0);
    expect(j).toMatchObject({ scheduleId: 'a', day: DAY, calls: 231, baselineDays: 7, billingUserId: 'owner-1' });
    expect(j.costUsd).toBeCloseTo(12.6);
    expect(j.baselineMedianUsd).toBeCloseTo(5.6);
    expect(j.ratio).toBeCloseTo(2.25);
  });

  it('sums every model row of a schedule on a day (a fallback model is part of the run)', () => {
    const rows = [...history('b', 4), row('b', DAY, 4.5), row('b', DAY, 29, 5, { model: 'openrouter/anthropic/claude-opus-5.5' })];
    expect(findScheduleCostJumps(rows, DAY)[0].costUsd).toBeCloseTo(33.5);
  });

  it('does not flag a day just under 2x', () => {
    expect(findScheduleCostJumps([...history('c', 5), row('c', DAY, 9.99)], DAY)).toEqual([]);
  });

  it('flags exactly 2x', () => {
    expect(findScheduleCostJumps([...history('c', 5), row('c', DAY, 10)], DAY)).toHaveLength(1);
  });

  it('never pages for a cheap schedule, even at a large ratio', () => {
    expect(findScheduleCostJumps([...history('d', 0.2), row('d', DAY, 2.99)], DAY)).toEqual([]);
  });

  it('skips a schedule with fewer than 3 billed baseline days (new schedules)', () => {
    expect(findScheduleCostJumps([...history('e', 1, 2), row('e', DAY, 50)], DAY)).toEqual([]);
    expect(findScheduleCostJumps([...history('e', 1, 3), row('e', DAY, 50)], DAY)).toHaveLength(1);
  });

  it('uses the median, so one earlier spike does not hide a new jump', () => {
    const rows = [...history('f', 4, 6), row('f', utcDay(Date.parse(`${DAY}T00:00:00Z`), -7), 40), row('f', DAY, 9)];
    expect(findScheduleCostJumps(rows, DAY)).toHaveLength(1);
  });

  it('ignores days outside the 7-day baseline window and the evaluated day itself', () => {
    const old = row('g', utcDay(Date.parse(`${DAY}T00:00:00Z`), -8), 1);
    const rows = [old, old, old, ...history('g', 10, 3), row('g', DAY, 15)];
    // Baseline is the three $10 days only; $15 is 1.5x, not a jump. With the old $1 days counted it would be.
    expect(findScheduleCostJumps(rows, DAY)).toEqual([]);
  });

  it('ignores non-scheduled features and malformed rows', () => {
    const rows = [
      ...history('h', 1),
      row('h', DAY, 50, 1, { feature: 'agent_task:interactive' }),
      row('h', DAY, 50, 1, { feature: 'agent_task:scheduled:' }),
      { ...row('h', DAY, 50), date: undefined as unknown as string },
    ];
    expect(findScheduleCostJumps(rows, DAY)).toEqual([]);
  });

  it('counts exactly the 7 days before the evaluated day (day -8 never enters the median)', () => {
    const d = (n: number) => utcDay(Date.parse(`${DAY}T00:00:00Z`), -n);
    // In-window baseline $4, $10, $10 -> median $10, so $15 is not a jump. Adding day -8 ($1) would make it $7.
    const rows = [row('w', d(1), 4), row('w', d(2), 10), row('w', d(3), 10), row('w', d(8), 1), row('w', DAY, 15)];
    expect(findScheduleCostJumps(rows, DAY)).toEqual([]);
  });

  it('only reads scheduled-run rows (an interactive feature never forms a fake schedule)', () => {
    const interactive = (date: string, usd: number) => row('ignored', date, usd, 1, { feature: 'agent_task:interactive' });
    const rows = [...Array.from({ length: 7 }, (_, i) => interactive(utcDay(Date.parse(`${DAY}T00:00:00Z`), -(i + 1)), 1)), interactive(DAY, 50)];
    expect(findScheduleCostJumps(rows, DAY)).toEqual([]);
  });

  it('leaves zero-cost days out of the baseline', () => {
    const d = (n: number) => utcDay(Date.parse(`${DAY}T00:00:00Z`), -n);
    const rows = [row('k', d(1), 5), row('k', d(2), 5), row('k', d(3), 5), row('k', d(4), 0), row('k', d(5), 0), row('k', d(6), 0), row('k', d(7), 0), row('k', DAY, 12)];
    expect(findScheduleCostJumps(rows, DAY)).toHaveLength(1);
  });

  it('orders the jumps by cost, most expensive first', () => {
    const rows = [...history('x', 2), row('x', DAY, 6), ...history('y', 5), row('y', DAY, 30)];
    expect(findScheduleCostJumps(rows, DAY).map(j => j.scheduleId)).toEqual(['y', 'x']);
  });
});

describe('helpers', () => {
  it('median of odd/even/empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it('utcDay offsets in whole UTC days', () => {
    expect(utcDay(NOW, -1)).toBe('2026-11-11');
    expect(utcDay(NOW, -8)).toBe('2026-11-04');
  });
  it('totalsBySchedule tolerates non-numeric counters', () => {
    const t = totalsBySchedule([row('z', DAY, 1), { ...row('z', DAY, 1), costMicroUsd: NaN, callCount: NaN }]);
    expect(t.get('z')?.get(DAY)).toMatchObject({ costUsd: 1, calls: 10 });
  });
});

describe('runScheduleCostJumpCheck', () => {
  it('reads the ledger for the evaluated day plus the 7 days before it, and sends one digest', async () => {
    const read = jest.fn(async () => [...history('a', 5.6), row('a', DAY, 12.6, 231), ...history('b', 3), row('b', DAY, 3.2)]);
    const s = await runScheduleCostJumpCheck(NOW, read);
    expect(read).toHaveBeenCalledWith('2026-11-04', DAY);
    expect(s).toEqual({ day: DAY, rowsRead: 16, jumps: 1, alertSent: true });
    expect(alert).toHaveBeenCalledTimes(1);
    const [subject, message] = alert.mock.calls[0];
    expect(subject).toBe('1 scheduled run cost 2x+ more than usual on 2026-11-11');
    expect(message).toContain('schedule a: $12.60 on 2026-11-11 (231 calls), 2.3x its median of $5.60/day over 7 prior day(s)');
  });

  it('emails a given day at most once per process, and retries a day whose email was not sent', async () => {
    const rows = async () => [...history('a', 2), row('a', DAY, 9)];
    alert.mockResolvedValueOnce(false);
    expect((await runScheduleCostJumpCheck(NOW, rows)).alertSent).toBe(false);
    expect((await runScheduleCostJumpCheck(NOW, rows)).alertSent).toBe(true);
    expect((await runScheduleCostJumpCheck(NOW, rows)).alertSent).toBe(false);
    expect(alert).toHaveBeenCalledTimes(2);
    // The next day is a new digest.
    const next = Date.parse('2026-11-13T06:00:00.000Z');
    const nextRows = async () => [...history('a', 2).map(r => ({ ...r, date: utcDay(Date.parse(`${r.date}T00:00:00Z`), 1) })), row('a', '2026-11-12', 9)];
    expect((await runScheduleCostJumpCheck(next, nextRows)).alertSent).toBe(true);
    expect(alert).toHaveBeenCalledTimes(3);
  });

  it('sends nothing on a normal day', async () => {
    const s = await runScheduleCostJumpCheck(NOW, async () => [...history('a', 5.6), row('a', DAY, 6)]);
    expect(s.jumps).toBe(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it('survives a ledger read failure without alerting', async () => {
    const s = await runScheduleCostJumpCheck(NOW, async () => { throw new Error('ProvisionedThroughputExceeded'); });
    expect(s).toEqual({ day: DAY, rowsRead: 0, jumps: 0, alertSent: false });
    expect(alert).not.toHaveBeenCalled();
  });

  it('survives an alert failure', async () => {
    alert.mockRejectedValueOnce(new Error('resend down'));
    const s = await runScheduleCostJumpCheck(NOW, async () => [...history('a', 2), row('a', DAY, 9)]);
    expect(s.jumps).toBe(1);
    expect(s.alertSent).toBe(false);
  });

  it('uses the real ledger reader by default', async () => {
    const { usageRecordDb } = jest.requireMock('../../services/usageRecordDb');
    usageRecordDb.scanByDateRange.mockResolvedValueOnce([]);
    await runScheduleCostJumpCheck(NOW);
    expect(usageRecordDb.scanByDateRange).toHaveBeenCalledWith('2026-11-04', DAY);
  });
});

describe('scheduleCostJumpTick (one UTC hour a day, so a deploy never repeats a day)', () => {
  const IN_HOUR = Date.parse('2026-11-12T07:05:00.000Z');
  const jumpRows = async () => [...history('a', 2), row('a', DAY, 9)];

  it('acts only during the send hour (07 UTC) and reads nothing outside it', async () => {
    expect(SCHEDULE_COST_JUMP_SEND_HOUR_UTC).toBe(7);
    const read = jest.fn(jumpRows);
    for (const t of ['2026-11-12T06:59:59.000Z', '2026-11-12T08:00:00.000Z', '2026-11-12T19:00:00.000Z']) {
      expect(await scheduleCostJumpTick(Date.parse(t), read)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
    expect((await scheduleCostJumpTick(Date.parse('2026-11-12T07:00:00.000Z'), read))?.alertSent).toBe(true);
    expect((await scheduleCostJumpTick(Date.parse('2026-11-12T07:59:59.000Z'), read))).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('sends a flagged day once, and later ticks of the hour read nothing', async () => {
    const read = jest.fn(jumpRows);
    expect((await scheduleCostJumpTick(IN_HOUR, read))?.alertSent).toBe(true);
    expect(await scheduleCostJumpTick(IN_HOUR + 15 * 60_000, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('finishes a day with no jump after one read', async () => {
    const read = jest.fn(async () => [...history('a', 5), row('a', DAY, 5)]);
    expect((await scheduleCostJumpTick(IN_HOUR, read))?.jumps).toBe(0);
    expect(await scheduleCostJumpTick(IN_HOUR + 15 * 60_000, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('tries again on the next tick of the hour when the send or the read failed', async () => {
    alert.mockResolvedValueOnce(false);
    const read = jest.fn(jumpRows);
    expect((await scheduleCostJumpTick(IN_HOUR, read))?.alertSent).toBe(false);
    expect((await scheduleCostJumpTick(IN_HOUR + 15 * 60_000, read))?.alertSent).toBe(true);
    expect(alert).toHaveBeenCalledTimes(2);

    resetScheduleCostJumpDedupe();
    alert.mockClear();
    const failing = jest.fn().mockRejectedValueOnce(new Error('throttled')).mockImplementation(jumpRows);
    expect((await scheduleCostJumpTick(IN_HOUR, failing))?.rowsRead).toBe(0);
    expect((await scheduleCostJumpTick(IN_HOUR + 15 * 60_000, failing))?.alertSent).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
