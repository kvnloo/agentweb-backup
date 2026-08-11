/**
 * ENG-1099 — non-production backends must never file on the production Linear board.
 *
 * `sendOncallAlert` has always carried a `NODE_ENV !== 'production'` guard; the intake rail sitting
 * next to it on the same failure paths did not, so any test-env/local/preview backend filed real
 * `Auto` issues indistinguishable from genuine production incidents (ENG-857 + its two dedupes were
 * all manufactured this way). The guard below matches sendOncallAlert's mechanism exactly rather
 * than inventing a second environment convention.
 */
import { createInternalLinearIssue, _resetLinearTeamCache } from '../services/linearService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'lin_api_test' })),
}));

const TEAM_RESPONSE = {
  data: {
    teams: {
      nodes: [{
        id: 'team_eng',
        states: { nodes: [{ id: 'st_backlog', name: 'Backlog', type: 'backlog' }] },
        labels: { nodes: [{ id: 'lab_bug', name: 'Bug' }, { id: 'lab_auto', name: 'Auto' }] },
      }],
    },
  },
};

const ORIGINAL_ENV = process.env.NODE_ENV;

describe('linearService.createInternalLinearIssue — non-production environment guard (ENG-1099)', () => {
  beforeEach(() => {
    _resetLinearTeamCache();
    (global.fetch as any) = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TEAM_RESPONSE) } as any),
    );
  });
  afterEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  // AC1 — zero issues created outside production.
  it.each(['test', 'development', 'staging'])(
    'creates NO issue and never calls Linear when NODE_ENV is %s',
    async (env) => {
      process.env.NODE_ENV = env;
      const result = await createInternalLinearIssue({
        title: 'worker crashed',
        description: 'stack trace',
        labelNames: ['Auto', 'Bug'],
      });
      expect(result).toBeNull();
      expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
    },
  );

  it('creates NO issue and never calls Linear when NODE_ENV is unset', async () => {
    delete process.env.NODE_ENV;
    const result = await createInternalLinearIssue({
      title: 'worker crashed',
      description: 'stack trace',
      labelNames: ['Auto', 'Bug'],
    });
    expect(result).toBeNull();
    expect(global.fetch as jest.Mock).not.toHaveBeenCalled();
  });

  // AC3 — the suppression is observable, not silent.
  it('logs what it WOULD have filed (title + labels) so a local intake decision is still visible', async () => {
    process.env.NODE_ENV = 'development';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await createInternalLinearIssue({
      title: 'scheduled chat error',
      description: 'the body a developer needs to see',
      labelNames: ['Auto', 'Oncall'],
    });
    const line = log.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(line).toContain('scheduled chat error');
    expect(line).toContain('Auto');
    expect(line).toContain('Oncall');
    log.mockRestore();
  });

  // AC2 — production behaviour is unchanged.
  it('still files exactly one issue when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1
        ? TEAM_RESPONSE
        : { data: { issueCreate: { success: true, issue: { id: 'uuid-99', identifier: 'ENG-99', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    const result = await createInternalLinearIssue({
      title: 'real prod incident',
      description: 'd',
      labelNames: ['Auto', 'Bug'],
    });
    expect(result).toEqual({ id: 'uuid-99', identifier: 'ENG-99', url: 'u' });
    const creates = (global.fetch as jest.Mock).mock.calls.filter(c => (c[1]?.body || '').includes('issueCreate'));
    expect(creates).toHaveLength(1);
  });
});
