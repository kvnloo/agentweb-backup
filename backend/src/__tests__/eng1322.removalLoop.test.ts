/**
 * ENG-1322 — the REMOVE approval loop, driven through the real handler.
 *
 * The binding primitive is unit-tested in eng1322.removalBinding. These drive
 * `handleCallGoogleAdsApi` itself, because the defect this guards is a WIRING defect: a
 * flag the model can set on its own reaching a permanent, unrecoverable deletion. Testing
 * the HMAC alone would prove the lock works while saying nothing about whether it is on
 * the door.
 */
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    removeConversionAction: jest.fn().mockResolvedValue(undefined),
    listConversionActions: jest.fn().mockResolvedValue([]),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';

const CUSTOMER = '1234567890';
const ACTION_A = `customers/${CUSTOMER}/conversionActions/111`;
const ACTION_B = `customers/${CUSTOMER}/conversionActions/222`;
let service: AgentModeService;

const remove = (extra: Record<string, unknown> = {}, resourceName = ACTION_A) =>
  service.handleCallGoogleAdsApi('user-123', {
    customer_id: CUSTOMER,
    entity_type: 'CONVERSION_ACTION',
    action: 'REMOVE',
    conversion_action_resource_name: resourceName,
    ...extra,
  }, { sessionId: 'sess-1' });

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
});

describe('ENG-1322 REMOVE cannot happen without a disclosed approval', () => {
  it('halts on a bare call and removes nothing', async () => {
    const r = await remove();
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(r.confirmationPrompt).toMatch(/PERMANENTLY stops/);
    expect(r.confirmationPrompt).toContain(ACTION_A);
    expect(googleAdsService.removeConversionAction).not.toHaveBeenCalled();
  });

  it('halts when the model sets the confirm flag by itself, which was the whole defect', async () => {
    const r = await remove({ confirm_conversion_action_removal: true });
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(googleAdsService.removeConversionAction).not.toHaveBeenCalled();
  });

  it('issues a USABLE token on the very first halt, so the loop is two steps not three', async () => {
    // CodeRabbit: gating the digest on the confirm flag made the first (unflagged) halt
    // disclose an empty string. The model replays what it is given, so it would be refused
    // for using the token it was just handed — a loop that looks broken from the outside.
    const first = await remove();
    expect(typeof first.conversion_action_removal_token).toBe('string');
    expect(first.conversion_action_removal_token.length).toBeGreaterThan(0);

    const second = await remove({
      confirm_conversion_action_removal: true,
      conversion_action_removal_token: first.conversion_action_removal_token,
    });
    expect(second.success).toBe(true);
    expect(second.awaitingUserConfirmation).toBeUndefined();
    expect(googleAdsService.removeConversionAction).toHaveBeenCalledWith('user-123', CUSTOMER, ACTION_A);
  });

  it('refuses a token minted for a DIFFERENT conversion action', async () => {
    // The case that matters: the destructive argument is the resource name, so an approval
    // for one removal must not authorise another the user never saw.
    const forB = await remove({}, ACTION_B);
    const r = await remove({
      confirm_conversion_action_removal: true,
      conversion_action_removal_token: forB.conversion_action_removal_token,
    }, ACTION_A);

    expect(r.awaitingUserConfirmation).toBe(true);
    expect(googleAdsService.removeConversionAction).not.toHaveBeenCalled();
  });

  it('refuses a forged token', async () => {
    const r = await remove({
      confirm_conversion_action_removal: true,
      conversion_action_removal_token: 'not-a-real-digest',
    });
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(googleAdsService.removeConversionAction).not.toHaveBeenCalled();
  });

  it('refuses a valid token when the confirm flag is absent', async () => {
    const first = await remove();
    const r = await remove({ conversion_action_removal_token: first.conversion_action_removal_token });
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(googleAdsService.removeConversionAction).not.toHaveBeenCalled();
  });
});
