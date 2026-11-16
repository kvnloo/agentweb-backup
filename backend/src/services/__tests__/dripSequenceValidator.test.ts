import { validateSequenceDefinition, DripStepDefinition } from '../dripSequenceValidator';

const step = (over: Partial<DripStepDefinition> = {}): DripStepDefinition => ({
  id: 's1',
  channel: 'email',
  delayMinutes: 0,
  subject: 'Hi {{first_name|there}}',
  html: '<p>Welcome to {{company}}</p>',
  ...over,
});
const codes = (steps: DripStepDefinition[], opts = {}) =>
  validateSequenceDefinition({ steps }, opts).errors.map((e) => [e.stepIndex, e.code]);

describe('validateSequenceDefinition', () => {
  it('accepts a valid multi-step sequence', () => {
    const r = validateSequenceDefinition({
      steps: [step(), step({ id: 's2', delayMinutes: 1440, html: undefined, text: 'Following up, {{ first_name }}' })],
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects empty sequences', () => {
    expect(codes([])).toEqual([[null, 'empty_sequence']]);
  });

  it('rejects missing and duplicate step ids', () => {
    expect(codes([step(), step({ id: 's1' }), step({ id: ' ' })])).toEqual([
      [1, 'duplicate_step_id'],
      [2, 'missing_step_id'],
    ]);
  });

  it('rejects negative, non-integer, and over-max delays', () => {
    expect(codes([step({ delayMinutes: -1 }), step({ id: 'b', delayMinutes: 1.5 }), step({ id: 'c', delayMinutes: 61 })], { maxDelayMinutes: 60 })).toEqual([
      [0, 'invalid_delay'],
      [1, 'invalid_delay'],
      [2, 'delay_exceeds_max'],
    ]);
  });

  it('rejects unknown channels', () => {
    expect(codes([step({ channel: 'sms' })])).toEqual([[0, 'unknown_channel']]);
  });

  it('rejects email steps missing subject or body', () => {
    expect(codes([step({ subject: '', html: undefined, text: '  ' })])).toEqual([
      [0, 'missing_subject'],
      [0, 'missing_body'],
    ]);
  });

  it('flags unsupported merge fields once per step, honoring knownFields', () => {
    expect(codes([step({ subject: '{{nickname}} {{nickname|x}}', html: '{{company}}' })])).toEqual([[0, 'unknown_merge_field']]);
    expect(codes([step({ subject: '{{nickname}}', html: 'x' })], { knownFields: ['nickname'] })).toEqual([]);
  });

  it('collects all errors across steps rather than failing on the first', () => {
    const r = validateSequenceDefinition({
      steps: [step({ delayMinutes: -5, subject: '' }), step({ id: 's1', channel: 'fax' })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['invalid_delay', 'missing_subject', 'duplicate_step_id', 'unknown_channel']);
  });
});
