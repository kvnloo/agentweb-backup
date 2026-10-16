/**
 * ENG-2515 (ENG-821 slice): the declared get_meta_ads_metrics schema and the
 * runtime argument contract must agree. Every shape the declared schema
 * accepts that carries a usable campaign id must validate AND reach the
 * handler as a non-empty campaign_ids array; genuinely invalid calls must fail
 * once with an actionable message naming the field.
 */
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';
import { getMetaAdsMetricsTool } from '../emma/metaTools';
import { getMetaAdsMetricsArgsSchema } from '../utils/metaCampaignIds';

const inputSchema = getMetaAdsMetricsTool.definition.inputSchema;
const validate = (args: Record<string, unknown>) =>
  validateAndRepairToolArgs({ toolName: 'get_meta_ads_metrics', args, inputSchema, effect: 'read' });
// get_meta_ads_metrics short-circuits to its typed zod schema, so check the
// declared JSON schema through the generic (untyped-tool) validation path.
const validateDeclared = (args: Record<string, unknown>) =>
  validateAndRepairToolArgs({ toolName: 'eng2515_declared_schema_probe', args, inputSchema, effect: 'read' });

describe('ENG-2515 get_meta_ads_metrics schema/runtime agreement', () => {
  // Schema-valid shapes from the ENG-821 invalid_args corpus class
  // (legacy scalar / string / JSON-string ids, alias keys, client scope).
  const schemaValid: Array<[string, Record<string, unknown>, string[]]> = [
    ['array ids', { campaign_ids: ['123', '456'] }, ['123', '456']],
    ['single string id', { campaign_ids: '123' }, ['123']],
    ['JSON-array string', { campaign_ids: '["123","456"]' }, ['123', '456']],
    ['legacy campaign_id', { campaign_id: '123' }, ['123']],
    ['legacy id with blank-only array', { campaign_ids: [' '], campaign_id: '123' }, ['123']],
    ['legacy id with empty string ids', { campaign_ids: '', campaign_id: '123' }, ['123']],
    ['client-scoped call', { campaign_ids: ['123'], account_id: 'act', client_id: 'c1', timeframe: '30d' }, ['123']],
  ];

  it.each(schemaValid)('accepts %s and the handler receives usable ids', (_label, args, expected) => {
    const result = validate(args);
    expect(result.status).not.toBe('invalid');
    expect(validateDeclared(args).status).not.toBe('invalid');
    // The gateway's returned args are what the runtime forwards to the handler.
    expect((result.args as { campaign_ids?: unknown }).campaign_ids).toEqual(expected);
    const parsed = getMetaAdsMetricsArgsSchema.safeParse(result.args);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.campaign_ids).toEqual(expected);
  });

  it('rejects a call with no usable campaign id, naming the field and the expected form', () => {
    const result = validate({ timeframe: '7d', campaign_ids: ['  '] });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      const issue = result.issues.find((i) => i.path === '$.campaign_ids');
      expect(issue?.message).toMatch(/campaign_ids \(array or string\) or campaign_id/);
    }
  });

  it('rejects an out-of-enum timeframe with the allowed values', () => {
    const result = validate({ campaign_ids: ['123'], timeframe: 'last_month' });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.some((i) => i.path === '$.timeframe' && /7d, 14d, 30d, 90d/.test(i.message))).toBe(true);
    }
  });
});
