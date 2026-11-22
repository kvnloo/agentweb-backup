import { sessionAwaitsConfirmation } from '../sessionHaltState';

const halt = { role: 'assistant', content: 'Approve?', metadata: { awaitingUserConfirmation: true } };

describe('sessionAwaitsConfirmation', () => {
  it('is true when the session ends on an assistant message that asked for confirmation', () => {
    expect(sessionAwaitsConfirmation([{ role: 'user' }, halt])).toBe(true);
  });

  it('ignores tool and system messages after the halt', () => {
    expect(sessionAwaitsConfirmation([{ role: 'user' }, halt, { role: 'tool' }, { role: 'system' }])).toBe(true);
  });

  it('is false once the user has replied', () => {
    expect(sessionAwaitsConfirmation([{ role: 'user' }, halt, { role: 'user' }])).toBe(false);
  });

  it('is false when a later assistant message did not ask for confirmation', () => {
    expect(sessionAwaitsConfirmation([halt, { role: 'user' }, { role: 'assistant', metadata: {} }])).toBe(false);
  });

  it('is false for an empty or missing history', () => {
    expect(sessionAwaitsConfirmation([])).toBe(false);
    expect(sessionAwaitsConfirmation(undefined)).toBe(false);
    expect(sessionAwaitsConfirmation(null)).toBe(false);
  });
});
