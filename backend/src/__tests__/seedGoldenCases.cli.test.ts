import { parseArgs } from '../scripts/seedGoldenCases';

describe('seedGoldenCases CLI arg parsing', () => {
  it('defaults to no per-surface target overrides and no write', () => {
    expect(parseArgs([])).toEqual({ write: false, targets: {} });
  });

  it('parses --target-agent, --target-creative and --target-account-health independently', () => {
    expect(parseArgs(['--target-agent', '60'])).toEqual({ write: false, targets: { agent: 60 } });
    expect(parseArgs(['--target-creative', '55'])).toEqual({ write: false, targets: { creative: 55 } });
    expect(parseArgs(['--target-account-health', '40'])).toEqual({ write: false, targets: { account_health: 40 } });
  });

  it('parses multiple target overrides plus --write and --fp-catalogue together', () => {
    expect(parseArgs(['--target-agent', '60', '--target-account-health', '40', '--write', '--fp-catalogue', 'catalogue.json'])).toEqual({
      write: true,
      fpCatalogue: 'catalogue.json',
      targets: { agent: 60, account_health: 40 },
    });
  });

  it('rejects a non-positive-integer target', () => {
    expect(() => parseArgs(['--target-agent', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--target-agent', 'abc'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--target-agent', '-5'])).toThrow(/positive integer/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument --bogus/);
  });
});

describe('seedGoldenCases --gated-creatives (ENG-2226)', () => {
  it('is off unless passed, and parses alongside the other flags', () => {
    expect(parseArgs([]).gatedCreatives).toBeUndefined();
    expect(parseArgs(['--gated-creatives', '--target-creative', '80'])).toEqual({ write: false, gatedCreatives: true, targets: { creative: 80 } });
  });
});
