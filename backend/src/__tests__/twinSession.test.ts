/**
 * Unit tests for the reusable-twin session helper (ENG-402).
 *
 * Runs in the DEFAULT `npm test` suite — it lives OUTSIDE the `/__tests__/twins/`
 * dir that jest.config.js excludes, and needs NO Arga twin: the filesystem and
 * the Arga CLI (`child_process.execFileSync`) are fully MOCKED. It proves the
 * config-parse / missing-config-skip / service-lookup / reset-tolerance behavior
 * that the opt-in twin suites depend on, without spending any Arga quota.
 */
import * as fs from 'fs';
import * as child_process from 'child_process';

jest.mock('fs');
jest.mock('child_process');

import {
  DEFAULT_TWIN_CONFIG_PATH,
  describeTwinSkip,
  getTwin,
  loadTwinConfig,
  resetTwinToBaseline,
  resolveArgaBin,
  resolveConfigPath,
  resolveTwinSession,
  TwinConfig,
} from './twins/twinSession';

const readFileSyncMock = fs.readFileSync as jest.Mock;
const existsSyncMock = fs.existsSync as jest.Mock;
const execFileSyncMock = child_process.execFileSync as jest.Mock;

const VALID_CONFIG: TwinConfig = {
  runId: 'run_abc123',
  twins: {
    slack: {
      baseUrl: 'https://pub-slack.twin',
      adminUrl: 'https://slack.twin',
      proxyToken: 'jwt_xyz',
      botToken: 'xoxb-seed',
    },
    stripe: { baseUrl: 'https://pub-stripe.twin' },
  },
};

function enoent(): NodeJS.ErrnoException {
  const e = new Error('ENOENT: mocked missing file') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  return e;
}

describe('twinSession — reusable-twin config helper (mocked fs + child_process)', () => {
  const savedConfigEnv = process.env.ARGA_TWIN_CONFIG;
  const savedArgaBin = process.env.ARGA_BIN;

  beforeEach(() => {
    readFileSyncMock.mockReset();
    existsSyncMock.mockReset();
    execFileSyncMock.mockReset();

    // Default: no config file present, no local arga binary, CLI calls no-op.
    readFileSyncMock.mockImplementation(() => {
      throw enoent();
    });
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockReturnValue(Buffer.from(''));

    delete process.env.ARGA_TWIN_CONFIG;
    delete process.env.ARGA_BIN;
  });

  afterAll(() => {
    if (savedConfigEnv === undefined) delete process.env.ARGA_TWIN_CONFIG;
    else process.env.ARGA_TWIN_CONFIG = savedConfigEnv;
    if (savedArgaBin === undefined) delete process.env.ARGA_BIN;
    else process.env.ARGA_BIN = savedArgaBin;
  });

  describe('loadTwinConfig', () => {
    it('parses a valid config file into runId + per-service coords', () => {
      readFileSyncMock.mockReturnValue(JSON.stringify(VALID_CONFIG));
      const cfg = loadTwinConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.runId).toBe('run_abc123');
      expect(cfg!.twins.stripe!.baseUrl).toBe('https://pub-stripe.twin');
      expect(cfg!.twins.slack!.botToken).toBe('xoxb-seed');
    });

    it('returns null when the config file is missing (ENOENT → clean skip)', () => {
      readFileSyncMock.mockImplementation(() => {
        throw enoent();
      });
      expect(loadTwinConfig()).toBeNull();
    });

    it('throws (fail-loud) on a present but corrupt config file', () => {
      readFileSyncMock.mockReturnValue('{ this is not json');
      expect(() => loadTwinConfig()).toThrow(/not valid JSON/);
    });

    it('throws when required fields (runId/twins) are missing', () => {
      readFileSyncMock.mockReturnValue(JSON.stringify({ twins: {} }));
      expect(() => loadTwinConfig()).toThrow(/missing required fields/);
    });
  });

  describe('resolveConfigPath', () => {
    it('defaults to backend/.env.twins.json', () => {
      expect(resolveConfigPath()).toBe(DEFAULT_TWIN_CONFIG_PATH);
      expect(DEFAULT_TWIN_CONFIG_PATH.endsWith('/.env.twins.json')).toBe(true);
    });

    it('honors the ARGA_TWIN_CONFIG override', () => {
      process.env.ARGA_TWIN_CONFIG = '/tmp/custom-twins.json';
      expect(resolveConfigPath()).toBe('/tmp/custom-twins.json');
    });
  });

  describe('getTwin', () => {
    it('returns the coords for a configured service', () => {
      readFileSyncMock.mockReturnValue(JSON.stringify(VALID_CONFIG));
      expect(getTwin('stripe')).toEqual({ baseUrl: 'https://pub-stripe.twin' });
      expect(getTwin('slack')!.adminUrl).toBe('https://slack.twin');
    });

    it('returns null for a service absent from the config', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ runId: 'r1', twins: { stripe: { baseUrl: 'x' } } }),
      );
      expect(getTwin('slack')).toBeNull();
    });

    it('returns null when no config file exists', () => {
      readFileSyncMock.mockImplementation(() => {
        throw enoent();
      });
      expect(getTwin('stripe')).toBeNull();
    });
  });

  describe('resolveTwinSession', () => {
    it('returns the config and no skipReason when the service is configured', () => {
      readFileSyncMock.mockReturnValue(JSON.stringify(VALID_CONFIG));
      const res = resolveTwinSession('slack');
      expect(res.skipReason).toBeNull();
      expect(res.config!.runId).toBe('run_abc123');
    });

    it('skips with describeTwinSkip() when no config exists', () => {
      readFileSyncMock.mockImplementation(() => {
        throw enoent();
      });
      const res = resolveTwinSession('stripe');
      expect(res.config).toBeNull();
      expect(res.skipReason).toBe(describeTwinSkip());
    });

    it('skips when the config lacks the requested service', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({ runId: 'r1', twins: { stripe: { baseUrl: 'x' } } }),
      );
      const res = resolveTwinSession('slack');
      expect(res.config).toBeNull();
      expect(res.skipReason).toMatch(/no 'slack' twin/);
    });
  });

  describe('describeTwinSkip', () => {
    it('names the setup script the dev must run', () => {
      expect(describeTwinSkip()).toContain('npm run test:twins:setup');
    });
  });

  describe('resetTwinToBaseline (best-effort)', () => {
    it('invokes `arga previews twins reset <runId>`', () => {
      execFileSyncMock.mockReturnValue(Buffer.from(''));
      resetTwinToBaseline('run_abc123', 'arga');
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'arga',
        ['previews', 'twins', 'reset', 'run_abc123'],
        expect.any(Object),
      );
    });

    it('tolerates a reset failure without throwing (warns instead of crashing the suite)', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      execFileSyncMock.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => resetTwinToBaseline('run_abc123', 'arga')).not.toThrow();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('no-ops on an empty runId (never shells out)', () => {
      resetTwinToBaseline('', 'arga');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('resolveArgaBin', () => {
    it('prefers the ARGA_BIN override', () => {
      process.env.ARGA_BIN = '/custom/arga';
      expect(resolveArgaBin()).toBe('/custom/arga');
    });

    it('falls back to a user-local install when it exists', () => {
      existsSyncMock.mockReturnValue(true);
      expect(resolveArgaBin()).toContain('.local/bin/arga');
    });

    it('falls back to `arga` on PATH when no local install exists', () => {
      existsSyncMock.mockReturnValue(false);
      expect(resolveArgaBin()).toBe('arga');
    });
  });
});
