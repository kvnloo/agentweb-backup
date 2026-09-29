/**
 * ENG-2145: offline eval suite CLI argument contract (staging/local only, explicit bypass).
 */
import { DEFAULT_LOCAL_BASELINE, buildSources, parseArgs } from '../loops/scripts/runOfflineEvalSuite';

const NOW = new Date('2026-09-26T08:00:00.000Z');

describe('runOfflineEvalSuite parseArgs', () => {
  it('defaults a local run to the committed deterministic baseline', () => {
    expect(parseArgs(['--target', 'local'], NOW)).toMatchObject({ target: 'local', baselineFile: DEFAULT_LOCAL_BASELINE, golden: false, bypass: null });
  });

  it('refuses production and a missing target', () => {
    expect(() => parseArgs(['--target', 'production'], NOW)).toThrow('never production');
    expect(() => parseArgs([], NOW)).toThrow('target must be local or staging');
  });

  it('requires an explicit baseline for staging', () => {
    expect(() => parseArgs(['--target', 'staging'], NOW)).toThrow('--baseline is required for a staging run');
    expect(parseArgs(['--target', 'staging', '--baseline', 'b.json', '--okareo-run', 'r'], NOW)).toMatchObject({ baselineFile: 'b.json', okareoRunId: 'r' });
  });

  it('takes a bypass only with who, why and ticket', () => {
    expect(() => parseArgs(['--target', 'local', '--bypass-by', 'Harsha'], NOW)).toThrow('by, reason and ticket are all required');
    expect(parseArgs(['--target', 'local', '--bypass-by', 'Harsha', '--bypass-reason', 'Okareo outage, hotfix', '--bypass-ticket', 'ENG-2151'], NOW).bypass)
      .toEqual({ by: 'Harsha', reason: 'Okareo outage, hotfix', ticket: 'ENG-2151', at: NOW.toISOString() });
  });

  it('pairs --write-baseline with --baseline-id', () => {
    expect(() => parseArgs(['--target', 'local', '--write-baseline', 'x.json'], NOW)).toThrow('go together');
  });

  it('adds the Okareo source for staging so a missing key fails closed', () => {
    const ids = (argv: string[]) => buildSources(parseArgs(argv, NOW), {}).map((s) => s.id);
    expect(ids(['--target', 'local'])).toEqual(['failure-replay', 'replay-fixtures']);
    expect(ids(['--target', 'staging', '--baseline', 'b.json'])).toEqual(['failure-replay', 'replay-fixtures', 'okareo']);
  });
});
