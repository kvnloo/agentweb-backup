import { evaluateSessionSpendBreaker } from '../sessionSpendBreaker';

const caps = { maxTurns: 40, maxSpendUsd: 5 };

describe('evaluateSessionSpendBreaker (ENG-2820)', () => {
  it('continues under both caps', () => {
    expect(evaluateSessionSpendBreaker({ turns: 10, spendUsd: 1, caps, isScheduled: false })).toEqual({
      action: 'continue',
      reason: 'under_caps',
      turns: 10,
      spendUsd: 1,
    });
  });

  it('pauses for confirmation on the turn cap for interactive sessions', () => {
    const d = evaluateSessionSpendBreaker({ turns: 40, spendUsd: 1, caps, isScheduled: false });
    expect(d.action).toBe('pause_for_confirmation');
    expect(d.reason).toBe('turn_cap');
  });

  it('pauses for confirmation on the spend cap', () => {
    const d = evaluateSessionSpendBreaker({ turns: 5, spendUsd: 5, caps, isScheduled: false });
    expect(d.action).toBe('pause_for_confirmation');
    expect(d.reason).toBe('spend_cap');
  });

  it('scheduled runs pause and notify instead of asking', () => {
    const d = evaluateSessionSpendBreaker({ turns: 41, spendUsd: 6, caps, isScheduled: true });
    expect(d.action).toBe('pause_and_notify');
    expect(d.reason).toBe('turn_and_spend_cap');
  });

  it('does not re-trip after confirmation until the next cap multiple', () => {
    const base = { caps, isScheduled: false, confirmedUpToTurn: 40 };
    expect(evaluateSessionSpendBreaker({ ...base, turns: 41, spendUsd: 5.5 }).action).toBe('continue');
    expect(evaluateSessionSpendBreaker({ ...base, turns: 79, spendUsd: 9.99 }).action).toBe('continue');
    expect(evaluateSessionSpendBreaker({ ...base, turns: 80, spendUsd: 6 }).action).toBe('pause_for_confirmation');
    expect(evaluateSessionSpendBreaker({ ...base, turns: 50, spendUsd: 10 }).reason).toBe('spend_cap');
  });

  it('ignores non-positive caps', () => {
    const d = evaluateSessionSpendBreaker({
      turns: 1000,
      spendUsd: 1000,
      caps: { maxTurns: 0, maxSpendUsd: Number.NaN },
      isScheduled: false,
    });
    expect(d.action).toBe('continue');
  });

  it('replays the Opiner runaway (549 turns, ~$47) and trips at the first cap', () => {
    const totalTurns = 549;
    const totalSpend = 47;
    let trippedAt: number | null = null;
    for (let turn = 1; turn <= totalTurns; turn++) {
      const spendUsd = (totalSpend * turn) / totalTurns;
      const d = evaluateSessionSpendBreaker({ turns: turn, spendUsd, caps, isScheduled: false });
      if (d.action !== 'continue') {
        trippedAt = turn;
        break;
      }
    }
    expect(trippedAt).toBe(40);
  });
});
