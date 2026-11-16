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

describe('seedGoldenCases --ad-connected-accounts (ENG-2135)', () => {
  it('is off unless passed, and parses alongside the other flags', () => {
    expect(parseArgs([]).adConnectedAccounts).toBeUndefined();
    expect(parseArgs(['--ad-connected-accounts', '--target-account-health', '50'])).toEqual({ write: false, adConnectedAccounts: true, targets: { account_health: 50 } });
  });
});

describe('seedGoldenCases --work-plan-sessions (ENG-665)', () => {
  it('parses the target, with or without --write', () => {
    expect(parseArgs(['--work-plan-sessions', '80'])).toEqual({ write: false, targets: {}, workPlanSessions: 80 });
    expect(parseArgs(['--work-plan-sessions', '80', '--write'])).toEqual({ write: true, targets: {}, workPlanSessions: 80 });
  });

  it('rejects a non-positive-integer target', () => {
    expect(() => parseArgs(['--work-plan-sessions', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--work-plan-sessions'])).toThrow(/positive integer/);
  });

  it('runs on its own: refuses to combine with the other seed options', () => {
    expect(() => parseArgs(['--work-plan-sessions', '80', '--target-agent', '60'])).toThrow(/runs on its own/);
    expect(() => parseArgs(['--work-plan-sessions', '80', '--gated-creatives'])).toThrow(/runs on its own/);
    expect(() => parseArgs(['--fp-catalogue', 'c.json', '--work-plan-sessions', '80'])).toThrow(/runs on its own/);
  });
});
