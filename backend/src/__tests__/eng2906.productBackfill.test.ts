/**
 * ENG-2906 PR2 — pure classification + write-safety for the product backfill
 * (scripts/eng2906-backfill-products.ts). No DynamoDB: every input is a fixture row shaped like
 * the real Dev-AW-LoopEvents (loop emma-mcp) and AW-ZomaDeviceAuth items.
 */
import {
  accountFlag,
  buildBackfillUpdates,
  classifyMcpEvent,
  csvRow,
  CSV_HEADER,
  planUserBackfill,
  zomaDeviceEvidence,
  type BackfillUser,
} from '../services/journeyProductBackfill';

const TOOLKIT_ONLY = new Set(['get_meta_ad_account_health', 'list_meta_catalogs']);
const NOW = new Date('2026-11-11T00:00:00.000Z');
const opts = { now: NOW, toolkitOnlyNames: TOOLKIT_ONLY };

const ev = (eventType: string, ts: string, dimensions: Record<string, string> = {}, subjectId = 'u1') => ({
  loopId: 'emma-mcp',
  tsSession: `${ts}#${subjectId}#${eventType}#abc`,
  eventType,
  subjectId,
  ts,
  dimensions,
});

const user = (over: Partial<BackfillUser> = {}): BackfillUser => ({
  email: 'a@example.com',
  userId: 'u1',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

describe('classifyMcpEvent', () => {
  it('zoma_token auth is zoma', () => {
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'zoma_token', toolName: 'call_meta_marketing_api' }), TOOLKIT_ONLY)?.product).toBe('zoma');
  });

  it('a zoma client (name or id) is zoma', () => {
    expect(classifyMcpEvent(ev('mcp_oauth_token_issued', '2026-10-01T10:00:00Z', { clientId: 'zoma-device-setup' }), TOOLKIT_ONLY)?.product).toBe('zoma');
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { clientName: 'Zoma CLI', toolName: 'search' }), TOOLKIT_ONLY)?.product).toBe('zoma');
  });

  it('zoma_ tools and toolkit-only manifest names are zoma', () => {
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { toolName: 'zoma_status' }), TOOLKIT_ONLY)?.product).toBe('zoma');
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { toolName: 'list_meta_catalogs' }), TOOLKIT_ONLY)?.product).toBe('zoma');
  });

  it('a Meta tool Emma /mcp also exposes is NOT zoma by name alone (shared tool name)', () => {
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'oauth', toolName: 'call_meta_marketing_api', clientType: 'claude_ai' }), TOOLKIT_ONLY)?.product).toBe('emma_mcp');
  });

  it('the gateway-only platform dimension marks a shared tool name as zoma', () => {
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-10-01T10:00:00Z', { toolName: 'call_meta_marketing_api', platform: 'meta' }), TOOLKIT_ONLY)?.product).toBe('zoma');
  });

  it('platform is Zoma evidence only in the exact shape the toolkit gateway writes it', () => {
    for (const platform of ['meta', 'google_ads']) {
      expect(classifyMcpEvent(ev('mcp_write_executed', '2026-10-01T10:00:00Z', { toolName: 'call_meta_marketing_api', platform }), TOOLKIT_ONLY)?.reason).toBe('toolkit_platform');
    }
    // An arbitrary platform value, or platform on an event type the gateway never stamps, is Emma.
    for (const row of [
      ev('mcp_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'oauth', toolName: 'search', clientType: 'claude_ai', platform: 'web' }),
      ev('mcp_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'oauth', toolName: 'search', platform: 'linkedin' }),
      ev('mcp_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'oauth', toolName: 'search', platform: 'META ' }),
      ev('mcp_connection_attempted', '2026-10-01T10:00:00Z', { authMethod: 'api_key', platform: 'meta' }),
      ev('mcp_first_tool_used', '2026-10-01T10:00:00Z', { authMethod: 'oauth', toolName: 'search', platform: 'google_ads' }),
    ]) {
      expect(classifyMcpEvent(row, TOOLKIT_ONLY)?.product).toBe('emma_mcp');
    }
  });

  it('a tracked product dimension wins over heuristics', () => {
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-11-10T10:00:00Z', { product: 'emma_mcp', toolName: 'zoma_status' }), TOOLKIT_ONLY)?.product).toBe('emma_mcp');
    expect(classifyMcpEvent(ev('mcp_tool_used', '2026-11-10T10:00:00Z', { product: 'zoma', toolName: 'search' }), TOOLKIT_ONLY)?.product).toBe('zoma');
  });

  it('any other MCP event is emma_mcp; client:* subjects, non-mcp events and bad timestamps are ignored', () => {
    expect(classifyMcpEvent(ev('mcp_connection_attempted', '2026-10-01T10:00:00Z', { authMethod: 'api_key' }), TOOLKIT_ONLY)?.product).toBe('emma_mcp');
    expect(classifyMcpEvent(ev('mcp_oauth_started', '2026-10-01T10:00:00Z', {}, 'client:abc'), TOOLKIT_ONLY)).toBeNull();
    expect(classifyMcpEvent(ev('run_completed', '2026-10-01T10:00:00Z'), TOOLKIT_ONLY)).toBeNull();
    expect(classifyMcpEvent(ev('mcp_tool_used', 'not-a-date'), TOOLKIT_ONLY)).toBeNull();
  });
});

describe('zomaDeviceEvidence', () => {
  it('collects the earliest approved device and token per user; ignores pending/denied/usercode rows', () => {
    const evidence = zomaDeviceEvidence([
      { pk: 'device#d1', status: 'issued', userId: 'u1', createdAt: '2026-10-02T00:00:00Z', ref: 'hn' },
      { pk: 'device#d0', status: 'approved', userId: 'u1', createdAt: '2026-10-01T09:30:00Z' },
      { pk: 'device#d2', status: 'denied', userId: 'u2', createdAt: '2026-10-01T00:00:00Z' },
      { pk: 'device#d3', status: 'pending', createdAt: '2026-10-01T00:00:00Z' },
      { pk: 'usercode#ABCD', deviceId: 'd1' },
      { pk: 'token#h1', userId: 'u1', createdAt: '2026-10-02T00:05:00Z', revoked: false },
    ]);
    expect(evidence.get('u1')).toEqual({ deviceAt: '2026-10-01T09:30:00Z', tokenAt: '2026-10-02T00:05:00Z', ref: undefined });
    expect(evidence.has('u2')).toBe(false);
  });
});

describe('planUserBackfill', () => {
  it('a Zoma user: products.zoma first/last, signup guess within 1h, stage = furthest reached, inferred', () => {
    const plan = planUserBackfill(
      user(),
      [
        ev('mcp_tool_used', '2026-10-01T10:20:00.000Z', { authMethod: 'zoma_token', toolName: 'list_meta_catalogs', clientType: 'unknown', ref: 'hn' }),
        ev('mcp_write_executed', '2026-10-03T00:00:00.000Z', { authMethod: 'zoma_token', toolName: 'call_meta_marketing_api', platform: 'meta' }),
        ev('mcp_tool_used', '2026-11-05T00:00:00.000Z', { authMethod: 'zoma_token', toolName: 'zoma_usage' }),
      ],
      { tokenAt: '2026-10-01T10:15:00.000Z' },
      opts,
    );
    expect(plan.products).toEqual({ zoma: { firstAt: '2026-10-01T10:15:00.000Z', lastAt: '2026-11-05T00:00:00.000Z' } });
    expect(plan.signupProduct).toBe('zoma');
    expect(plan.signupClient).toBe('zoma_device');
    expect(plan.signupRef).toBe('hn');
    expect(plan.zomaStage).toBe('first_write');
    expect(plan.zomaStageAt).toBe('2026-10-03T00:00:00.000Z');
    expect(plan.zomaFirstReadAt).toBe('2026-10-01T10:20:00.000Z');
    expect(plan.zomaFirstWriteAt).toBe('2026-10-03T00:00:00.000Z');
    expect(plan.attributionConfidence).toBe('inferred');
    expect(plan.last30dToolCalls).toBe(1);
  });

  it('an Emma MCP user whose first event is > 1h after signup gets products but no signup guess, no zoma stage', () => {
    const plan = planUserBackfill(
      user(),
      [ev('mcp_tool_used', '2026-10-05T00:00:00.000Z', { authMethod: 'oauth', toolName: 'search', clientType: 'claude_ai' })],
      undefined,
      opts,
    );
    expect(plan.products).toEqual({ emma_mcp: { firstAt: '2026-10-05T00:00:00.000Z', lastAt: '2026-10-05T00:00:00.000Z' } });
    expect(plan.signupProduct).toBeUndefined();
    expect(plan.zomaStage).toBeUndefined();
  });

  it('an Emma MCP signup within 1h records the clientType as signupClient', () => {
    const plan = planUserBackfill(
      user(),
      [
        ev('mcp_oauth_token_issued', '2026-10-01T10:30:00.000Z', { clientId: 'c-2', clientType: 'claude_code' }),
        ev('mcp_tool_used', '2026-10-01T12:00:00.000Z', { clientId: 'c-2', clientType: 'claude_code', toolName: 'search' }),
      ],
      undefined,
      opts,
    );
    expect(plan.signupProduct).toBe('emma_mcp');
    expect(plan.signupClient).toBe('claude_code');
  });

  it('no MCP and no Zoma device: emma_web signup and product', () => {
    const plan = planUserBackfill(user({ lastActiveAt: '2026-11-01T00:00:00.000Z' }), [], undefined, opts);
    expect(plan.signupProduct).toBe('emma_web');
    expect(plan.signupClient).toBe('web');
    expect(plan.products).toEqual({ emma_web: { firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-11-01T00:00:00.000Z' } });
  });

  it('pre-ENG-2906 OAuth events (shared OAuth server, no resource) are not Emma evidence on their own', () => {
    // founders@slashy.com shape: Codex authorized at signup but never called a tool; Zoma use 4 min later.
    const plan = planUserBackfill(
      user(),
      [
        ev('mcp_oauth_authorized', '2026-10-01T10:00:02.000Z', { authMethod: 'oauth', clientId: 'codex-1', clientName: 'Codex', clientType: 'codex' }),
        ev('mcp_oauth_token_issued', '2026-10-01T10:00:03.000Z', { authMethod: 'oauth', clientId: 'codex-1', clientName: 'Codex', clientType: 'codex' }),
        ev('mcp_oauth_token_issued', '2026-10-01T10:04:00.000Z', { authMethod: 'oauth', clientId: 'cc-1', clientName: 'Claude Code (zoma)', clientType: 'claude_code' }),
        ev('mcp_tool_used', '2026-10-01T10:04:10.000Z', { authMethod: 'oauth', clientId: 'cc-1', clientType: 'claude_code', toolName: 'zoma_status' }),
      ],
      undefined,
      opts,
    );
    expect(plan.signupProduct).toBe('zoma');
    expect(Object.keys(plan.products)).toEqual(['zoma']);
    expect(plan.evidence).toContain('unresolved_oauthx2');
  });

  it('an untracked OAuth event takes the product of the same client\'s tool use', () => {
    const plan = planUserBackfill(
      user(),
      [
        ev('mcp_oauth_token_issued', '2026-10-01T10:01:00.000Z', { authMethod: 'oauth', clientId: 'c-1', clientType: 'claude_ai' }),
        ev('mcp_tool_used', '2026-10-03T00:00:00.000Z', { authMethod: 'oauth', clientId: 'c-1', clientType: 'claude_ai', toolName: 'search' }),
      ],
      undefined,
      opts,
    );
    expect(plan.signupProduct).toBe('emma_mcp');
    expect(plan.products.emma_mcp?.firstAt).toBe('2026-10-01T10:01:00.000Z');
  });

  it('an approved device with no token and no tool use is stage connected', () => {
    const plan = planUserBackfill(user(), [], { deviceAt: '2026-10-08T00:00:00.000Z' }, opts);
    expect(plan.zomaStage).toBe('connected');
    expect(plan.zomaStageAt).toBe('2026-10-08T00:00:00.000Z');
    expect(plan.products.zoma?.firstAt).toBe('2026-10-08T00:00:00.000Z');
  });

  it('connected is the earliest of device approval, token issue and first Zoma event', () => {
    const plan = planUserBackfill(user(), [], { deviceAt: '2026-10-08T00:00:00.000Z', tokenAt: '2026-10-09T00:00:00.000Z' }, opts);
    expect(plan.zomaStageAt).toBe('2026-10-08T00:00:00.000Z');
  });

  it('a Zoma token with no tool use is stage connected', () => {
    const plan = planUserBackfill(user(), [], { tokenAt: '2026-10-09T00:00:00.000Z' }, opts);
    expect(plan.zomaStage).toBe('connected');
    expect(plan.zomaStageAt).toBe('2026-10-09T00:00:00.000Z');
    expect(plan.signupProduct).toBeUndefined();
  });
});

describe('buildBackfillUpdates — never overwrites', () => {
  const zomaEvents = [ev('mcp_tool_used', '2026-10-01T10:20:00.000Z', { authMethod: 'zoma_token', toolName: 'zoma_status' })];
  const writesFor = (u: BackfillUser, rows = zomaEvents, device?: { deviceAt?: string; tokenAt?: string }) =>
    buildBackfillUpdates(planUserBackfill(u, rows, device, opts), u, 'AW-Users');
  const find = (updates: ReturnType<typeof writesFor>, needle: string) => updates.find((x) => String(x.UpdateExpression).includes(needle));

  it('every SET is if_not_exists and every write guards existence + absent-or-inferred confidence', () => {
    const updates = writesFor(user());
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.TableName).toBe('AW-Users');
      expect(update.Key).toEqual({ email: 'a@example.com' });
      expect(update.ConditionExpression).toContain('attribute_exists(#email) AND (attribute_not_exists(#ac) OR #ac = :inferred)');
      expect(update.ExpressionAttributeNames?.['#ac']).toBe('attributionConfidence');
      expect(update.ExpressionAttributeValues?.[':inferred']).toBe('inferred');
      const assignments = String(update.UpdateExpression).replace(/^SET /, '').split(/, (?=#)/);
      for (const a of assignments) expect(a).toMatch(/^(#[\w.#]+) = if_not_exists\(\1, :\w+\)$/);
    }
    const signup = find(updates, '#signupProduct')!;
    expect(signup.UpdateExpression).toContain('#signupProduct = if_not_exists(#signupProduct, :signupProduct)');
    expect(signup.ConditionExpression).toContain('attribute_not_exists(#signupProduct) AND attribute_not_exists(#signupPath)');
  });

  it('zomaStageAt is never SET outright: both stage fields are if_not_exists and conditional', () => {
    const stage = find(writesFor(user()), '#zomaStage')!;
    expect(stage.UpdateExpression).toContain('#zomaStage = if_not_exists(#zomaStage, :stage)');
    expect(stage.UpdateExpression).toContain('#zomaStageAt = if_not_exists(#zomaStageAt, :at)');
    expect(stage.ConditionExpression).toContain('attribute_not_exists(#zomaStage) AND attribute_not_exists(#zomaStageAt)');
  });

  it('a row with an existing zomaStageAt but no zomaStage gets no stage write', () => {
    expect(find(writesFor(user({ zomaStageAt: '2026-11-10T00:00:00.000Z' })), '#zomaStage')).toBeUndefined();
  });

  it('a tracked or verified row gets NO write at all — not signup, products, stage or milestones', () => {
    for (const attributionConfidence of ['tracked', 'verified'] as const) {
      // Even with nothing else set, the confidence alone blocks every write.
      expect(writesFor(user({ attributionConfidence }), zomaEvents, { deviceAt: '2026-10-01T10:00:00.000Z' })).toEqual([]);
      expect(writesFor(user({ attributionConfidence, signupProduct: 'emma_web', signupPath: 'webapp' }))).toEqual([]);
    }
  });

  it('an unrecognised confidence value is treated like tracked: no write', () => {
    expect(writesFor(user({ attributionConfidence: 'explicit' }))).toEqual([]);
  });

  it('a row that gains products but no signup guess is still stamped attributionConfidence inferred', () => {
    // First evidence is days after signup, so there is no signup guess.
    const rows = [ev('mcp_tool_used', '2026-10-05T00:00:00.000Z', { authMethod: 'oauth', toolName: 'search', clientType: 'claude_ai' })];
    const updates = writesFor(user(), rows);
    expect(find(updates, '#signupProduct')).toBeUndefined();
    const product = find(updates, '#products')!;
    expect(product.UpdateExpression).toContain('#ac = if_not_exists(#ac, :inferred)');
  });

  it('a previously inferred row may still gain a missing signup guess and product', () => {
    const updates = writesFor(user({ attributionConfidence: 'inferred' }));
    expect(find(updates, '#signupProduct')).toBeDefined();
    expect(find(updates, '#products')).toBeDefined();
  });

  it('existing signup, products entries, stage and milestones are skipped, not rewritten', () => {
    const u = user({
      signupProduct: 'zoma',
      products: { zoma: { firstAt: '2026-11-10T00:00:00.000Z', lastAt: '2026-11-10T00:00:00.000Z' } },
      zomaStage: 'signed_up',
      zomaFirstReadAt: '2026-11-10T00:00:00.000Z',
    });
    expect(writesFor(u)).toEqual([]);
  });

  it('adds a missing product key to an existing products map without replacing the map', () => {
    const product = find(writesFor(user({ products: { emma_web: { firstAt: '2026-11-10T00:00:00.000Z', lastAt: '2026-11-10T00:00:00.000Z' } }, signupPath: 'webapp' })), '#products')!;
    expect(product.UpdateExpression).toContain('#products.#p = if_not_exists(#products.#p, :entry)');
    expect(product.ConditionExpression).toContain('attribute_exists(#products) AND attribute_not_exists(#products.#p)');
    expect(product.ExpressionAttributeNames?.['#p']).toBe('zoma');
  });

  it('a row with no products map gets the map created only if it is still absent', () => {
    const product = find(writesFor(user()), '#products')!;
    expect(product.UpdateExpression).toContain('#products = if_not_exists(#products, :products)');
    expect(product.ConditionExpression).toContain('attribute_not_exists(#products)');
  });
});

describe('accountFlag', () => {
  it('flags our domains and admin rows as internal, fixtures as test, real customers as nothing', () => {
    expect(accountFlag('harsha@agentweb.pro')).toBe('internal');
    expect(accountFlag('dev@argusoft.com')).toBe('internal');
    expect(accountFlag('someone@gmail.com', true)).toBe('internal');
    expect(accountFlag('qa-user@agentweb.pro')).toBe('internal');
    expect(accountFlag('test@example.com')).toBe('test');
    expect(accountFlag('jane+test@gmail.com')).toBe('test');
    expect(accountFlag('eng658-realdomain-check@acme.io')).toBe('test');
    expect(accountFlag('founders@slashy.com')).toBeUndefined();
    expect(accountFlag('contest.winner@acme.io')).toBeUndefined();
  });

  it('the plan and CSV carry the flag', () => {
    const plan = planUserBackfill(user({ email: 'qa@example.com' }), [], undefined, opts);
    expect(plan.accountFlag).toBe('test');
    expect(csvRow(plan).endsWith(',test')).toBe(true);
  });
});

describe('csv', () => {
  it('has the contract header and escapes values', () => {
    expect(CSV_HEADER).toBe('email,userId,createdAt,signupProduct,products,zomaStage,evidence,last30dToolCalls,accountFlag');
    const plan = planUserBackfill(user({ email: 'x,"y"@example.com' }), [], undefined, opts);
    expect(csvRow(plan).startsWith('"x,""y""@example.com",u1,')).toBe(true);
  });
});
