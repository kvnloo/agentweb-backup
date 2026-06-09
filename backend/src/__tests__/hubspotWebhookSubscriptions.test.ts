/**
 * Tests for ensureWebhookSubscriptions — auto-registration of HubSpot webhook
 * subscriptions on config save.
 */

jest.mock('axios');
jest.mock('../utils/secretsManager', () => ({
  getHubSpotCredentials: jest.fn(),
}));

import axios from 'axios';
import { getHubSpotCredentials } from '../utils/secretsManager';
import { ensureWebhookSubscriptions } from '../utils/hubspotWebhookSubscriptions';

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockGetCreds = getHubSpotCredentials as jest.Mock;

const DEV_KEY = 'test-dev-key-abc123';

function makeSubsResponse(subs: Array<{ eventType: string; propertyName: string }>) {
  return {
    data: {
      results: subs.map((s, i) => ({ id: i + 1, eventType: s.eventType, propertyName: s.propertyName, active: true })),
    },
  };
}

const ALL_CONTACT_PROPS = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url'];
const ALL_DEAL_PROPS = ['amount', 'dealstage', 'deal_currency_code'];

describe('ensureWebhookSubscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCreds.mockResolvedValue({ clientId: 'id', clientSecret: 'secret', developerApiKey: DEV_KEY });
    mockAxiosGet.mockResolvedValue(makeSubsResponse([]));
    mockAxiosPost.mockResolvedValue({ data: { id: 99, active: true } });
  });

  // ── Credential guard ─────────────────────────────────────────────────────────

  it('skips entirely when developerApiKey is absent', async () => {
    mockGetCreds.mockResolvedValue({ clientId: 'id', clientSecret: 'secret' });
    await ensureWebhookSubscriptions([], []);
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── First-time registration ──────────────────────────────────────────────────

  it('registers all 7 standard contact props when none subscribed', async () => {
    await ensureWebhookSubscriptions([], []);
    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    for (const prop of ALL_CONTACT_PROPS) {
      expect(bodies).toContainEqual(
        expect.objectContaining({ eventType: 'contact.propertyChange', propertyName: prop })
      );
    }
  });

  it('registers all 3 standard deal props when none subscribed', async () => {
    await ensureWebhookSubscriptions([], []);
    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    for (const prop of ALL_DEAL_PROPS) {
      expect(bodies).toContainEqual(
        expect.objectContaining({ eventType: 'deal.propertyChange', propertyName: prop })
      );
    }
  });

  it('makes exactly 10 POST calls on a clean slate (7 contact + 3 deal)', async () => {
    await ensureWebhookSubscriptions([], []);
    expect(mockAxiosPost).toHaveBeenCalledTimes(10);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────────

  it('skips props that are already subscribed', async () => {
    mockAxiosGet.mockResolvedValue(makeSubsResponse([
      { eventType: 'contact.propertyChange', propertyName: 'email' },
      { eventType: 'deal.propertyChange', propertyName: 'amount' },
    ]));

    await ensureWebhookSubscriptions([], []);

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).not.toContainEqual(expect.objectContaining({ propertyName: 'email' }));
    expect(bodies).not.toContainEqual(
      expect.objectContaining({ eventType: 'deal.propertyChange', propertyName: 'amount' })
    );
  });

  it('does nothing when all standard props already subscribed', async () => {
    const allSubs = [
      ...ALL_CONTACT_PROPS.map(p => ({ eventType: 'contact.propertyChange', propertyName: p })),
      ...ALL_DEAL_PROPS.map(p => ({ eventType: 'deal.propertyChange', propertyName: p })),
    ];
    mockAxiosGet.mockResolvedValue(makeSubsResponse(allSubs));

    await ensureWebhookSubscriptions([], []);

    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Custom mapped props ──────────────────────────────────────────────────────

  it('registers enabled non-push-only custom mapped props', async () => {
    const customMapping = [
      { crmProperty: 'my_crm_field', enabled: true, direction: 'both' },
      { crmProperty: 'pull_only_field', enabled: true, direction: 'pull' },
    ];

    await ensureWebhookSubscriptions([], customMapping);

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).toContainEqual(
      expect.objectContaining({ eventType: 'contact.propertyChange', propertyName: 'my_crm_field' })
    );
    expect(bodies).toContainEqual(
      expect.objectContaining({ eventType: 'contact.propertyChange', propertyName: 'pull_only_field' })
    );
  });

  it('registers enabled non-push-only contact mapped props', async () => {
    const contactMapping = [
      { crmProperty: 'custom_contact_prop', enabled: true, direction: 'both' },
    ];

    await ensureWebhookSubscriptions(contactMapping, []);

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).toContainEqual(
      expect.objectContaining({ eventType: 'contact.propertyChange', propertyName: 'custom_contact_prop' })
    );
  });

  it('skips push-only mappings (no webhook needed for push-only fields)', async () => {
    await ensureWebhookSubscriptions(
      [{ crmProperty: 'push_only_field', enabled: true, direction: 'push' }],
      []
    );

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).not.toContainEqual(expect.objectContaining({ propertyName: 'push_only_field' }));
  });

  it('skips disabled mappings', async () => {
    await ensureWebhookSubscriptions(
      [{ crmProperty: 'disabled_field', enabled: false, direction: 'both' }],
      []
    );

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).not.toContainEqual(expect.objectContaining({ propertyName: 'disabled_field' }));
  });

  it('normalises crmProperty to lowercase before registering', async () => {
    await ensureWebhookSubscriptions(
      [],
      [{ crmProperty: 'MyCustomField', enabled: true, direction: 'both' }]
    );

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).toContainEqual(expect.objectContaining({ propertyName: 'mycustomfield' }));
    expect(bodies).not.toContainEqual(expect.objectContaining({ propertyName: 'MyCustomField' }));
  });

  it('deduplicates: same prop in contactMapping and customMapping registered once', async () => {
    const sharedProp = { crmProperty: 'shared_field', enabled: true, direction: 'both' };
    await ensureWebhookSubscriptions([sharedProp], [sharedProp]);

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    const sharedCalls = bodies.filter((b: any) => b.propertyName === 'shared_field');
    expect(sharedCalls).toHaveLength(1);
  });

  // ── Auth ─────────────────────────────────────────────────────────────────────

  it('uses hapikey on both GET and POST requests', async () => {
    await ensureWebhookSubscriptions([], []);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/subscriptions'),
      expect.objectContaining({ params: { hapikey: DEV_KEY } })
    );
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/subscriptions'),
      expect.any(Object),
      expect.objectContaining({ params: { hapikey: DEV_KEY } })
    );
  });

  // ── Response shape handling ──────────────────────────────────────────────────

  it('handles legacy array-shaped GET response without re-registering already-subscribed props', async () => {
    mockAxiosGet.mockResolvedValue({
      data: [{ id: 1, eventType: 'contact.propertyChange', propertyName: 'email', active: true }],
    });

    await ensureWebhookSubscriptions([], []);

    const bodies = mockAxiosPost.mock.calls.map((c: any[]) => c[1]);
    expect(bodies).not.toContainEqual(expect.objectContaining({ propertyName: 'email' }));
  });

  it('treats unknown GET response shape as empty (registers all props)', async () => {
    mockAxiosGet.mockResolvedValue({ data: null });

    await ensureWebhookSubscriptions([], []);

    expect(mockAxiosPost).toHaveBeenCalledTimes(10);
  });

  // ── Error resilience ─────────────────────────────────────────────────────────

  it('continues registering remaining props when one POST fails', async () => {
    mockAxiosPost
      .mockRejectedValueOnce({ response: { status: 409, data: { message: 'CONFLICT' } } })
      .mockResolvedValue({ data: { id: 99 } });

    await expect(ensureWebhookSubscriptions([], [])).resolves.not.toThrow();
    // 10 total attempted despite first failure
    expect(mockAxiosPost).toHaveBeenCalledTimes(10);
  });

  it('swallows outer error gracefully when GET subscriptions fails', async () => {
    mockAxiosGet.mockRejectedValue(new Error('Network timeout'));
    await expect(ensureWebhookSubscriptions([], [])).resolves.not.toThrow();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('swallows outer error gracefully when getHubSpotCredentials throws', async () => {
    mockGetCreds.mockRejectedValue(new Error('Secrets Manager unavailable'));
    await expect(ensureWebhookSubscriptions([], [])).resolves.not.toThrow();
  });
});
