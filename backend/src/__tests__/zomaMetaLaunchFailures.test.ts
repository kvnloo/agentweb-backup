/**
 * Zoma call_meta_marketing_api failures reported from the Haven launch (customer operator report).
 *  1a. A Meta refusal reaches the caller with Meta's full error (title, user message, code,
 *      subcode, fbtrace_id), never a bare "Invalid parameter".
 *  4.  An unexpected toolkit failure is never the bare "Meta Toolkit call failed.".
 *  6.  "Call zoma_status: it returns the exact fix" is only for setup/auth failures; a Meta
 *      validation error points at Meta's error fields.
 *  7.  CAMPAIGN CREATE accepts the campaign's fields nested as params.campaign.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});
jest.mock('../mcp/metaToolkitGateway', () => ({
  authenticateMetaToolkitCaller: jest.fn(),
  handleMetaToolkitCall: jest.fn(),
  MetaToolkitAuthError: class MetaToolkitAuthError extends Error {},
}));

import { describeMetaError, metaErrorFields } from '../utils/metaErrorDetail';
import { metaToolkitFailureMessage } from '../routes/metaToolkit';
import { zomaErrorNextStep } from '../mcp/zomaNextStep';
import { flattenNestedCampaignCreate } from '../services/agentMode/metaCampaignCreateParams';
import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const GRAPH_BODY = {
  message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 1487079,
  error_user_title: 'Promoted object is missing', error_user_msg: 'Select a pixel and a conversion event.', fbtrace_id: 'AxYz',
};

describe('1a — describeMetaError keeps every field Meta returned', () => {
  it.each([
    ['handleError structuredError', Object.assign(new Error('Invalid parameter'), { structuredError: GRAPH_BODY })],
    ['SDK FacebookRequestError (response = Graph body)', Object.assign(new Error('Invalid parameter'), { response: GRAPH_BODY })],
    ['axios error (response.data.error)', Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { error: GRAPH_BODY } } })],
    ['re-thrown metaError', Object.assign(new Error('Select a pixel and a conversion event.'), { metaError: GRAPH_BODY })],
  ])('%s', (_label, error) => {
    const text = describeMetaError(error);
    for (const part of ['Invalid parameter', 'Promoted object is missing', 'Select a pixel and a conversion event.', 'code 100', 'subcode 1487079', 'fbtrace_id AxYz']) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('status code 400');
  });

  it('a plain local error has no Meta fields and keeps its own message', () => {
    expect(metaErrorFields(new Error('boom'))).toBeNull();
    expect(describeMetaError(new Error('boom'))).toBe('boom');
  });
});

describe('4 — the toolkit never answers with the bare generic failure', () => {
  it('a Meta refusal returns Meta\'s reason', () => {
    const msg = metaToolkitFailureMessage(Object.assign(new Error('Invalid parameter'), { response: GRAPH_BODY }));
    expect(msg).not.toBe('Meta Toolkit call failed.');
    expect(msg).toContain('Promoted object is missing');
    expect(msg).toContain('subcode 1487079');
  });

  it('a local exception names its class without leaking its text', () => {
    const msg = metaToolkitFailureMessage(new TypeError('secret internals at /srv/app'));
    expect(msg).toMatch(/^Meta Toolkit call failed: internal error \(TypeError\)/);
    expect(msg).not.toMatch(/secret|srv/);
  });

  it('redacts an access token that appears in Meta-shaped detail', () => {
    const msg = metaToolkitFailureMessage({ structuredError: { message: 'bad url ?access_token=EAAB1234567890abcdefghijklmnop', code: 100, error_subcode: 1 } });
    expect(msg).not.toMatch(/EAAB1234567890/);
  });
});

describe('6 — next step after a failure', () => {
  const ZOMA_STATUS = /Call zoma_status: it returns the exact fix/;

  it('a Meta validation error points at Meta\'s error fields, not zoma_status', () => {
    const next = zomaErrorNextStep(describeMetaError({ structuredError: GRAPH_BODY }));
    expect(next).not.toMatch(ZOMA_STATUS);
    expect(next).toMatch(/error_user_title \/ error_user_msg/);
    expect(zomaErrorNextStep('Meta refused the COPY: Invalid parameter (code 100). Nothing was changed.')).not.toMatch(ZOMA_STATUS);
    expect(zomaErrorNextStep('Not prepared, nothing was sent to Meta: PARAM_VALIDATION_ERROR: Campaign CREATE requires "name".')).not.toMatch(ZOMA_STATUS);
  });

  it('setup / auth failures still get the zoma_status fix', () => {
    for (const m of [
      'No usable Meta ad account is connected. Connect or reconnect Meta.',
      'This Meta connection was not granted the ads_management permission, so Zoma cannot change ads on it.',
      'Error validating access token: Session has expired (code 190, subcode 463)',
    ]) {
      expect(zomaErrorNextStep(m)).toMatch(ZOMA_STATUS);
    }
  });

  it('an unrelated failure does not claim zoma_status has the exact fix', () => {
    expect(zomaErrorNextStep('Write blocked by anomaly gate.')).not.toMatch(ZOMA_STATUS);
  });
});

describe('7 — CAMPAIGN CREATE accepts the nested campaign form', () => {
  const HINT = 'one entity per call';

  it('lifts params.campaign into params', () => {
    expect(flattenNestedCampaignCreate({ campaign: { name: 'Haven', objective: 'OUTCOME_LEADS' }, special_ad_categories: [] }, HINT))
      .toEqual({ params: { name: 'Haven', objective: 'OUTCOME_LEADS', special_ad_categories: [] } });
    expect(flattenNestedCampaignCreate({ name: 'Flat' }, HINT)).toEqual({ params: { name: 'Flat' } });
  });

  it('refuses conflicting duplicates and ad set / ads riding along, naming the way forward', () => {
    expect(flattenNestedCampaignCreate({ name: 'A', campaign: { name: 'B' } }, HINT).error).toMatch(/different values for name/);
    const withChildren = flattenNestedCampaignCreate({ campaign: { name: 'A' }, ad_set: {}, ads: [] }, HINT);
    expect(withChildren.error).toMatch(/params\.ad_set, params\.ads/);
    expect(withChildren.error).toContain(HINT);
  });

  it('the Zoma write path previews a nested CAMPAIGN CREATE instead of refusing "requires name"', async () => {
    const preview = jest.fn(async (_u: string, entity: string, action: string, accountId: string, _c?: string, _as?: string, _ad?: string, params?: any) => ({
      success: true, awaitingUserConfirmation: true, summary: `${action} ${entity} "${params.name}"`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, params },
    }));
    const deps = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: 'act_111', config: { account_type: 'ad_account', access_token: 't', ad_account_id: '111', granted_scopes: ['ads_read', 'ads_management'] } }]),
      previewMoney: jest.fn(async (_u: string, _a: string, params: any) => ({ params, confirmation: '' })),
      preview, dispatch: jest.fn(), readBack: jest.fn(), assertCreativeOwned: jest.fn(),
      spendCeilingPolicy: () => null, secret: () => 's', now: () => 1_800_000_000_000, consumedTokens: new Map(),
    } as unknown as MetaToolkitWriteDeps;

    const result: any = await executeMetaToolkitWrite('u1', {
      entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '111',
      params: { campaign: { name: 'Haven Launch', objective: 'OUTCOME_LEADS', special_ad_categories: [] } },
    }, deps);

    expect(result.status).toBe('PREVIEW');
    expect(result.preview).toContain('Objective: OUTCOME_LEADS');
    expect(preview.mock.calls[0][7]).toEqual({ name: 'Haven Launch', objective: 'OUTCOME_LEADS', special_ad_categories: [], status: 'PAUSED' });
  });

  it('the Zoma schema no longer advertises a one-call campaign + ad set + ads create', () => {
    const tool: any = getMetaToolkitManifest().find((t: any) => t.name === 'call_meta_marketing_api');
    const props = tool.inputSchema.properties.params.properties;
    expect(props.ad_set).toBeUndefined();
    expect(props.ads).toBeUndefined();
    expect(props.campaign.description).toMatch(/Creates the campaign only/);
  });
});
