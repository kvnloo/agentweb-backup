// ENG-567 TDD contract: one canonical connection catalog powers outcome
// filters + full-catalog search, and every entry explains Emma read/do.
import {
  CONNECTION_CATALOG,
  OUTCOME_FILTERS,
  bucketForAccountStatus,
  connectionsForOutcome,
  searchCatalog,
} from '../services/connectionCatalog';
import { getAllAvailableConnectedAccounts } from '../services/subscriptionService';

describe('ENG-567 connection catalog', () => {
  test('every gated platform has exactly one catalog entry', () => {
    const gated = getAllAvailableConnectedAccounts();
    const catalogued = new Set(CONNECTION_CATALOG.map((c) => c.platform));
    for (const p of gated) {
      expect(catalogued.has(p)).toBe(true);
    }
    expect(CONNECTION_CATALOG.length).toBe(new Set(CONNECTION_CATALOG.map((c) => c.platform)).size);
  });

  test('every entry explains what Emma can read and do', () => {
    for (const c of CONNECTION_CATALOG) {
      expect(c.emmaCanRead.trim().length).toBeGreaterThan(0);
      expect(c.emmaCanDo.trim().length).toBeGreaterThan(0);
    }
  });

  test('every outcome minimum resolves against the catalog (no drift)', () => {
    for (const o of OUTCOME_FILTERS) {
      const resolved = connectionsForOutcome(o.key);
      expect(resolved.map((c) => c.platform)).toEqual(o.minimumPlatforms);
      for (const c of resolved) {
        expect(c.outcomes).toContain(o.key);
      }
    }
  });

  test('duplicate pass: catalog entries reference only known outcomes', () => {
    const known = new Set(OUTCOME_FILTERS.map((o) => o.key));
    for (const c of CONNECTION_CATALOG) {
      expect(c.outcomes.length).toBeGreaterThan(0);
      for (const o of c.outcomes) expect(known.has(o)).toBe(true);
    }
  });

  test('search is the escape hatch: every entry findable', () => {
    expect(searchCatalog('')).toHaveLength(CONNECTION_CATALOG.length);
    for (const c of CONNECTION_CATALOG) {
      expect(searchCatalog(c.platform)).toContainEqual(c);
    }
    expect(searchCatalog('no-such-connection-xyz')).toHaveLength(0);
  });

  test('status buckets are distinct: connected / available / unavailable / action_required', () => {
    const allowed = ['gmail', 'meta'];
    expect(bucketForAccountStatus({ platform: 'gmail', status: 'active' }, allowed)).toBe('connected');
    expect(bucketForAccountStatus({ platform: 'gmail', status: 'never-connected' }, allowed)).toBe('available');
    expect(bucketForAccountStatus({ platform: 'hubspot', status: 'active' }, allowed)).toBe('unavailable');
    expect(bucketForAccountStatus({ platform: 'meta', status: 'disconnected' }, allowed)).toBe('action_required');
    expect(bucketForAccountStatus({ platform: 'meta', status: 'Reconnect required' }, allowed)).toBe('action_required');
    expect(bucketForAccountStatus({ platform: 'meta', status: 'token expired' }, allowed)).toBe('action_required');
  });
});
