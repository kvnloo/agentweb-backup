/**
 * ENG-2906 PR1 — product derivation, ref validation, and the AW-Users attribution writes
 * (write-once signup fields, throttled products map, forward-only zomaStage). The store is a
 * mocked UpdateItem seam: these tests assert the exact conditional expressions, because the
 * guarantees (write-once, forward-only, no ghost rows) live in DynamoDB, not in a read.
 */
import {
  advanceZomaStage,
  createJourneyAttribution,
  markZomaMilestone,
  MCP_CONSENT_SIGNUP_SOURCE,
  toUserAttributionConfidence,
  productFromRequestPath,
  productFromResource,
  readRef,
  recordSignupAttribution,
  touchProduct,
  validateRef,
  ZOMA_STAGES,
  type JourneyAttributionDeps,
} from '../services/journeyAttribution';

const conditionalFailure = () => Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' });

function deps(overrides: Partial<JourneyAttributionDeps> = {}): JourneyAttributionDeps & { update: jest.Mock } {
  return {
    update: jest.fn().mockResolvedValue({}),
    resolveEmail: jest.fn().mockResolvedValue('owner@acme.com'),
    now: () => Date.parse('2026-11-10T12:00:00.000Z'),
    tableName: 'Dev-AW-Users',
    ...overrides,
  } as any;
}

describe('ENG-2906 product derivation', () => {
  const base = 'https://api.agentweb.pro';

  it('maps the RFC 8707 resource for /mcp to emma_mcp and the Meta Toolkit MCP to zoma (explicit)', () => {
    expect(productFromResource(`${base}/mcp`, base)).toEqual({ product: 'emma_mcp', confidence: 'explicit' });
    expect(productFromResource(`${base}/api/meta-toolkit/mcp`, base)).toEqual({ product: 'zoma', confidence: 'explicit' });
    expect(productFromResource(`${base}/api/meta-toolkit/mcp/`, base)).toEqual({ product: 'zoma', confidence: 'explicit' });
  });

  it('returns unknown (never throws) for a missing, malformed, foreign, or other-path resource', () => {
    for (const resource of [undefined, '', 'not a url', ['x'], 'https://evil.example/mcp', `${base}/api/other`]) {
      expect(productFromResource(resource, base)).toEqual({ product: 'unknown', confidence: 'unknown' });
    }
  });

  it('maps request paths for usage events', () => {
    expect(productFromRequestPath('/mcp')).toBe('emma_mcp');
    expect(productFromRequestPath('/api/meta-toolkit/mcp')).toBe('zoma');
    expect(productFromRequestPath('/api/meta-toolkit/tools/x/call')).toBe('zoma');
    expect(productFromRequestPath('/api/elsewhere')).toBe('unknown');
  });
});

describe('ENG-2906 ref validation', () => {
  it('accepts /^[a-z0-9_-]{1,64}$/ only', () => {
    expect(validateRef('lp-zoma_01')).toBe('lp-zoma_01');
    expect(validateRef('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['', 'A', 'has space', 'a'.repeat(65), 'x@y.com', '../x', ['a'], 7, undefined, null]) {
      expect(validateRef(bad)).toBeUndefined();
    }
  });

  it('reads ref from an MCP resource URL query and ignores an invalid one', () => {
    expect(readRef('https://api.agentweb.pro/api/meta-toolkit/mcp?ref=hn_launch')).toBe('hn_launch');
    expect(readRef('https://api.agentweb.pro/mcp?ref=BAD!')).toBeUndefined();
    expect(readRef('nope')).toBeUndefined();
  });
});

describe('ENG-2906 signup attribution (write-once)', () => {
  it('writes every signup field with if_not_exists under attribute_not_exists(signupPath), keyed by EMAIL', async () => {
    const d = deps();
    const wrote = await recordSignupAttribution(
      'user-1',
      { product: 'zoma', path: 'zoma_device', client: 'zoma_device', ref: 'hn', confidence: 'inferred' },
      {},
      d,
    );
    expect(wrote).toBe(true);
    const params = d.update.mock.calls[0][0];
    expect(params.TableName).toBe('Dev-AW-Users');
    expect(params.Key).toEqual({ email: 'owner@acme.com' });
    for (const field of ['signupProduct', 'signupPath', 'signupClient', 'signupRef', 'attributionConfidence']) {
      expect(params.UpdateExpression).toContain(`#${field} = if_not_exists(#${field}, :${field})`);
    }
    expect(params.ConditionExpression).toContain('attribute_exists(#email)');
    expect(params.ConditionExpression).toContain('attribute_not_exists(#signupPath)');
    expect(params.ExpressionAttributeValues[':signupRef']).toBe('hn');
  });

  it('returns false (not an error) when the signup was already attributed', async () => {
    const d = deps({ update: jest.fn().mockRejectedValue(conditionalFailure()) } as any);
    await expect(
      recordSignupAttribution('user-1', { product: 'emma_web', path: 'webapp', client: 'web', confidence: 'explicit' }, {}, d),
    ).resolves.toBe(false);
  });

  it('restricts a deferred OAuth signup to a row stamped as a consent-page signup, never by account age', async () => {
    const d = deps();
    await recordSignupAttribution(
      'user-1',
      { product: 'emma_mcp', path: 'oauth_direct', client: 'claude_code', confidence: 'explicit' },
      { requireSignupSource: MCP_CONSENT_SIGNUP_SOURCE },
      d,
    );
    const params = d.update.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('#signupSource = :signupSource');
    expect(params.ExpressionAttributeValues[':signupSource']).toBe('mcp');
    expect(params.ConditionExpression).not.toContain('createdAt');
  });

  it('stores attributionConfidence with the contract enum: explicit -> tracked', async () => {
    const d = deps();
    await recordSignupAttribution('user-1', { product: 'zoma', path: 'oauth_direct', client: 'claude_code', confidence: 'explicit' }, {}, d);
    expect(d.update.mock.calls[0][0].ExpressionAttributeValues[':attributionConfidence']).toBe('tracked');
  });

  it('keeps inferred as inferred and omits an unknown confidence instead of inventing one', async () => {
    const inferred = deps();
    await recordSignupAttribution('user-1', { product: 'emma_web', path: 'webapp', client: 'web', confidence: 'inferred' }, {}, inferred);
    expect(inferred.update.mock.calls[0][0].ExpressionAttributeValues[':attributionConfidence']).toBe('inferred');

    const unknown = deps();
    await recordSignupAttribution('user-1', { product: 'unknown', path: 'oauth_direct', client: 'unknown', confidence: 'unknown' }, {}, unknown);
    const params = unknown.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('attributionConfidence');
    expect(params.ExpressionAttributeNames['#attributionConfidence']).toBeUndefined();
  });

  it('never writes explicit or unknown as a user-row confidence', () => {
    expect(toUserAttributionConfidence('explicit')).toBe('tracked');
    expect(toUserAttributionConfidence('inferred')).toBe('inferred');
    expect(toUserAttributionConfidence('unknown')).toBeUndefined();
    expect(toUserAttributionConfidence('verified')).toBe('verified');
  });

  it('omits signupRef when no valid ref was provided', async () => {
    const d = deps();
    await recordSignupAttribution('user-1', { product: 'emma_web', path: 'webapp', client: 'web', ref: 'BAD REF', confidence: 'explicit' }, {}, d);
    expect(d.update.mock.calls[0][0].UpdateExpression).not.toContain('signupRef');
  });

  it('writes nothing when the user cannot be resolved', async () => {
    const d = deps({ resolveEmail: jest.fn().mockResolvedValue(undefined) } as any);
    await expect(
      recordSignupAttribution('ghost', { product: 'emma_web', path: 'webapp', client: 'web', confidence: 'explicit' }, {}, d),
    ).resolves.toBe(false);
    expect(d.update).not.toHaveBeenCalled();
  });
});

describe('ENG-2906 zomaStage (forward-only conditional write)', () => {
  it('declares the documented stage order', () => {
    expect(ZOMA_STAGES).toEqual([
      'setup_started', 'signed_up', 'connected', 'platform_connected', 'card_saved', 'first_read', 'first_write', 'ad_live',
    ]);
  });

  it('only advances from a strictly earlier stage, in one conditional UpdateItem (no read)', async () => {
    const d = deps();
    const attribution = createJourneyAttribution(d);
    await expect(attribution.advanceZomaStage('user-1', 'card_saved')).resolves.toBe(true);
    const params = d.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET #zomaStage = :stage, #zomaStageAt = :now');
    expect(params.ConditionExpression).toContain('attribute_exists(#email)');
    expect(params.ConditionExpression).toContain('attribute_not_exists(#zomaStage) OR #zomaStage IN (:s0, :s1, :s2, :s3)');
    expect([':s0', ':s1', ':s2', ':s3'].map((k) => params.ExpressionAttributeValues[k])).toEqual([
      'setup_started', 'signed_up', 'connected', 'platform_connected',
    ]);
    expect(params.ExpressionAttributeValues[':stage']).toBe('card_saved');
  });

  it('reports a backwards/equal move as not advanced and never rewrites it', async () => {
    const d = deps({ update: jest.fn().mockRejectedValue(conditionalFailure()) } as any);
    const attribution = createJourneyAttribution(d);
    await expect(attribution.advanceZomaStage('user-1', 'connected')).resolves.toBe(false);
    // Memoized: a second identical attempt in this process does not hit DynamoDB again.
    await expect(attribution.advanceZomaStage('user-1', 'connected')).resolves.toBe(false);
    expect(d.update).toHaveBeenCalledTimes(1);
  });

  it('can require the user to already be a Zoma user (shared Meta/Google/Stripe paths)', async () => {
    const d = deps();
    await advanceZomaStage('user-1', 'platform_connected', { requireZoma: true }, d);
    const params = d.update.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('attribute_exists(#products.#zoma)');
  });

  it('first stage has no IN list', async () => {
    const d = deps();
    await advanceZomaStage('user-1', 'setup_started', {}, d);
    expect(d.update.mock.calls[0][0].ConditionExpression).toContain('attribute_not_exists(#zomaStage)');
    expect(d.update.mock.calls[0][0].ConditionExpression).not.toContain(' IN ');
  });
});

describe('ENG-2906 first_read / first_write milestones (independent of the stage)', () => {
  it('sets each milestone timestamp write-once, keyed by email', async () => {
    const d = deps();
    await expect(markZomaMilestone('user-1', 'first_read', d)).resolves.toBe(true);
    const params = d.update.mock.calls[0][0];
    expect(params.Key).toEqual({ email: 'owner@acme.com' });
    expect(params.UpdateExpression).toBe('SET #m = :now');
    expect(params.ConditionExpression).toBe('attribute_exists(#email) AND attribute_not_exists(#m)');
    expect(params.ExpressionAttributeNames['#m']).toBe('zomaFirstReadAt');
    expect(params.ConditionExpression).not.toContain('zomaStage');
  });

  it('first_read is still recorded after first_write already moved the stage past it', async () => {
    const d = deps();
    const attribution = createJourneyAttribution(d);
    await expect(attribution.markZomaMilestone('user-1', 'first_write')).resolves.toBe(true);
    await expect(attribution.markZomaMilestone('user-1', 'first_read')).resolves.toBe(true);
    expect(d.update.mock.calls.map((c) => c[0].ExpressionAttributeNames['#m'])).toEqual(['zomaFirstWriteAt', 'zomaFirstReadAt']);
  });

  it('an already-set milestone returns false and is not retried in this process', async () => {
    const d = deps({ update: jest.fn().mockRejectedValue(conditionalFailure()) } as any);
    const attribution = createJourneyAttribution(d);
    await expect(attribution.markZomaMilestone('user-1', 'first_read')).resolves.toBe(false);
    await expect(attribution.markZomaMilestone('user-1', 'first_read')).resolves.toBe(false);
    expect(d.update).toHaveBeenCalledTimes(1);
  });
});

describe('ENG-2906 products map', () => {
  it('creates the product entry write-once (firstAt) when absent', async () => {
    const d = deps();
    const attribution = createJourneyAttribution(d);
    await expect(attribution.touchProduct('user-1', 'zoma')).resolves.toBe('created');
    const params = d.update.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET #products.#p = :entry');
    expect(params.ConditionExpression).toBe('attribute_exists(#email) AND attribute_not_exists(#products.#p)');
    expect(params.ExpressionAttributeValues[':entry']).toEqual({ firstAt: '2026-11-10T12:00:00.000Z', lastAt: '2026-11-10T12:00:00.000Z' });
  });

  it('initialises the products map when it does not exist yet', async () => {
    const missingPath = Object.assign(new Error('The document path provided in the update expression is invalid for update'), { code: 'ValidationException' });
    const update = jest.fn().mockRejectedValueOnce(missingPath).mockResolvedValueOnce({});
    const d = deps({ update } as any);
    await expect(touchProduct('user-1', 'emma_mcp', d)).resolves.toBe('created');
    const params = update.mock.calls[1][0];
    expect(params.UpdateExpression).toBe('SET #products = :products');
    expect(params.ConditionExpression).toBe('attribute_exists(#email) AND attribute_not_exists(#products)');
    expect(params.ExpressionAttributeValues[':products']).toEqual({ emma_mcp: { firstAt: '2026-11-10T12:00:00.000Z', lastAt: '2026-11-10T12:00:00.000Z' } });
  });

  it('only bumps lastAt when the stored lastAt is older than an hour, never firstAt', async () => {
    const update = jest.fn().mockRejectedValueOnce(conditionalFailure()).mockResolvedValueOnce({});
    const d = deps({ update } as any);
    await expect(touchProduct('user-1', 'zoma', d)).resolves.toBe('touched');
    const params = update.mock.calls[1][0];
    expect(params.UpdateExpression).toBe('SET #products.#p.#lastAt = :now');
    expect(params.ConditionExpression).toBe('#products.#p.#lastAt < :cutoff');
    expect(params.ExpressionAttributeValues[':cutoff']).toBe('2026-11-10T11:00:00.000Z');
    expect(params.UpdateExpression).not.toContain('firstAt');
  });

  it('throttles in-process: a second touch within the hour does not write', async () => {
    const d = deps();
    const attribution = createJourneyAttribution(d);
    await attribution.touchProduct('user-1', 'zoma');
    await expect(attribution.touchProduct('user-1', 'zoma')).resolves.toBe('throttled');
    expect(d.update).toHaveBeenCalledTimes(1);
  });

  it('never records unknown as a product', async () => {
    const d = deps();
    await expect(touchProduct('user-1', 'unknown' as any, d)).resolves.toBe('skipped');
    expect(d.update).not.toHaveBeenCalled();
  });
});
