/**
 * ENG-2137: CLI range parsing for scripts/evalAgentGraders.ts (CodeRabbit on #3076).
 */
import { judgeCriteriaRates, parseArgs } from '../scripts/evalAgentGraders';
import { wilsonInterval } from '../loops/eval/agreement';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('evalAgentGraders parseArgs', () => {
  it('treats a date-only --to as the whole day, inclusive', () => {
    const opts = parseArgs(['--from', '2026-09-18', '--to', '2026-09-25'], NOW);
    expect(opts.from).toBe('2026-09-18T00:00:00.000Z');
    expect(opts.to).toBe('2026-09-25T23:59:59.999Z');
  });

  it('keeps an explicit --to timestamp as given', () => {
    expect(parseArgs(['--to', '2026-09-25T06:00:00.000Z'], NOW).to).toBe('2026-09-25T06:00:00.000Z');
  });

  it('defaults to the last 7 days when neither flag is given', () => {
    const opts = parseArgs([], NOW);
    expect(opts.from).toBe('2026-09-18T12:00:00.000Z');
    expect(opts.to).toBe('2026-09-25T12:00:00.000Z');
  });

  it('rejects a flag with a missing operand instead of silently defaulting', () => {
    expect(() => parseArgs(['--from'], NOW)).toThrow('--from needs a value');
    expect(() => parseArgs(['--to', '--json'], NOW)).toThrow('--to needs a value');
  });

  it('rejects an inverted range and an invalid date', () => {
    expect(() => parseArgs(['--from', '2026-09-26', '--to', '2026-09-25'], NOW)).toThrow('--from must not be after --to');
    expect(() => parseArgs(['--from', 'yesterday'], NOW)).toThrow('--from must be a date');
    expect(() => parseArgs(['--to', '2026-02-30'], NOW)).toThrow('--to must be a date, got "2026-02-30"');
    expect(() => parseArgs(['--from', '2026-04-31'], NOW)).toThrow('--from must be a date');
  });
});

describe('judgeCriteriaRates (ENG-2189)', () => {
  it('reports the share of shadow-judged sessions where each behaviour happened, with n and a Wilson CI', () => {
    const rates = judgeCriteriaRates([
      { arguedWithInstruction: true, failedToEscalate: false },
      { arguedWithInstruction: false, failedToEscalate: false },
      { arguedWithInstruction: 'yes' },
      undefined,
    ]);
    expect(rates).toEqual([
      { criterion: 'arguedWithInstruction', n: 2, happened: 1, rate: 0.5, ci: wilsonInterval(1, 2) },
      { criterion: 'escalatedWhenNotRequired', n: 0, happened: 0, rate: null, ci: null },
      { criterion: 'failedToEscalate', n: 2, happened: 0, rate: 0, ci: wilsonInterval(0, 2) },
    ]);
  });
});
