/**
 * ENG-1322 follow-up — CONVERSION_ACTION REMOVE is bound to a disclosed approval.
 *
 * `confirm_conversion_action_removal: true` used to be sufficient on its own, and the model
 * sets its own arguments. So the only thing between a model that decided to tidy up a
 * conversion action and a permanent, unrecoverable removal was a sentence in the tool
 * description asking it not to. ENG-941 already settled that this is not a control:
 * "an override the model can introduce after approval is not user-granted, whatever the
 * tool description says."
 *
 * The outcome guarded here is strictly worse than the tracking waiver that reasoning was
 * written for: a removed conversion action cannot be re-enabled, and every campaign bidding
 * toward it stops counting it.
 *
 * The binding is the SAME primitive as ENG-1526 rather than a second mechanism — an HMAC
 * over the exact call, keyed with a server-only secret.
 */
const mockRemove = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    removeConversionAction: (...a: any[]) => mockRemove(...a),
    getAccountCredentials: jest.fn().mockResolvedValue({ accessToken: 't', loginCustomerId: undefined }),
  },
}));

import { computeTrackingOverrideDigest, trackingOverrideTokenMatches } from '../services/metaLaunchGate';

const SECRET = 'test-secret';
const CUSTOMER = '1234567890';
const ACTION_A = `customers/${CUSTOMER}/conversionActions/111`;
const ACTION_B = `customers/${CUSTOMER}/conversionActions/222`;

const digestFor = (resourceName: string) =>
  computeTrackingOverrideDigest(SECRET, {
    customer_id: CUSTOMER,
    entity_type: 'CONVERSION_ACTION',
    action: 'REMOVE',
    conversion_action_resource_name: resourceName,
  });

describe('ENG-1322 the removal token is bound to the exact conversion action', () => {
  it('accepts the token minted for this conversion action', () => {
    expect(trackingOverrideTokenMatches(digestFor(ACTION_A), digestFor(ACTION_A))).toBe(true);
  });

  it('REFUSES a token minted for a DIFFERENT conversion action', () => {
    // The case that matters. The destructive argument here is the resource name, so a
    // token that travels between actions would let an approval for one removal authorise
    // another the user never saw.
    expect(trackingOverrideTokenMatches(digestFor(ACTION_B), digestFor(ACTION_A))).toBe(false);
  });

  it('refuses an absent token — the confirm flag alone approves nothing', () => {
    expect(trackingOverrideTokenMatches(undefined, digestFor(ACTION_A))).toBe(false);
    expect(trackingOverrideTokenMatches('', digestFor(ACTION_A))).toBe(false);
  });

  it('refuses a forged token', () => {
    expect(trackingOverrideTokenMatches('not-a-real-digest', digestFor(ACTION_A))).toBe(false);
  });

  it('refuses a token minted against a different customer', () => {
    const other = computeTrackingOverrideDigest(SECRET, {
      customer_id: '9999999999',
      entity_type: 'CONVERSION_ACTION',
      action: 'REMOVE',
      conversion_action_resource_name: ACTION_A,
    });
    expect(trackingOverrideTokenMatches(other, digestFor(ACTION_A))).toBe(false);
  });

  it('is stable across key order, so a re-emitted argument object still matches', () => {
    // The replay is built by the model and need not preserve key order.
    const reordered = computeTrackingOverrideDigest(SECRET, {
      conversion_action_resource_name: ACTION_A,
      action: 'REMOVE',
      entity_type: 'CONVERSION_ACTION',
      customer_id: CUSTOMER,
    });
    expect(trackingOverrideTokenMatches(reordered, digestFor(ACTION_A))).toBe(true);
  });

  it('cannot be minted without the server secret', () => {
    const forged = computeTrackingOverrideDigest('attacker-guess', {
      customer_id: CUSTOMER,
      entity_type: 'CONVERSION_ACTION',
      action: 'REMOVE',
      conversion_action_resource_name: ACTION_A,
    });
    expect(trackingOverrideTokenMatches(forged, digestFor(ACTION_A))).toBe(false);
  });
});
