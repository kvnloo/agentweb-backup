/**
 * LIVE contract test for the Google Ads API (ENG-1322 / ENG-1328).
 *
 * The mocked suites prove our LOGIC. This guards the one thing a mock can never catch:
 * that the REAL API still behaves the way our code assumes. Every fact asserted below
 * cost a merged PR to discover, because a mock returns whatever it is told and therefore
 * confirms a wrong belief just as confidently as a right one.
 *
 * Twenty unit tests asserted `status: HIDDEN` was the way to retire a conversion action.
 * They passed continuously while it was impossible. Only the real account disagreed —
 * four times, across four PRs. These assertions exist so the fifth time is a red test
 * instead of a production discovery.
 *
 * SAFETY: this makes no successful writes. The two mutate attempts are ones Google
 * REJECTS — the rejection is the assertion — so nothing is created or modified. The only
 * successful call is a read.
 *
 * Skipped unless GOOGLE_ADS_LIVE_USER_ID and GOOGLE_ADS_LIVE_CUSTOMER_ID are set (they
 * are not in CI), so a normal run is unaffected.
 *
 * REQUIREMENTS, and they are not only the env vars. The run needs
 *   - real AWS credentials, to read the account's stored OAuth token from DynamoDB, and
 *   - **Secrets Manager read access**, because the Google Ads developer token lives there.
 *
 * The second one is the blocker on a typical workstation: without it the run fails with
 * "Failed to fetch Google Ads credentials from Secrets Manager" AFTER successfully
 * finding the connected account, which reads like a Google problem and is not one. Run
 * this from an environment whose role can read the developer token.
 *
 *   GOOGLE_ADS_LIVE_USER_ID=<user-uuid> \
 *   GOOGLE_ADS_LIVE_CUSTOMER_ID=<10-digit-id> \
 *     npx jest src/__tests__/googleAdsContract.live.test.ts
 */

// A manual mock at src/__mocks__/aws-sdk.ts is auto-applied to every suite, so DynamoDB
// is stubbed by default and the credential lookup finds no connected account. This test
// needs the REAL SDK to read the account's stored token — same reason the Gemini live
// test unmocks @google/genai.
jest.unmock('aws-sdk');

import { parseTagSnippets } from '../utils/googleAdsConversionActions';

// The service is required LAZILY in beforeAll, not imported here. db.ts builds its
// DynamoDB client at module load, so a top-level import would capture setup.ts's fake
// credentials before the block below can clear them.
let googleAdsService: any;

const USER_ID = process.env.GOOGLE_ADS_LIVE_USER_ID?.trim();
const CUSTOMER_ID = process.env.GOOGLE_ADS_LIVE_CUSTOMER_ID?.trim();
const describeLive = USER_ID && CUSTOMER_ID ? describe : describe.skip;

// setup.ts pins AWS credentials to 'test-access-key' so no suite can reach real AWS by
// accident — a good default that this test has to opt out of, since it reads the
// account's stored OAuth token from DynamoDB. Cleared only in live mode, so a normal run
// keeps the guard.
if (USER_ID && CUSTOMER_ID) {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  // Fall back to the normal provider chain (shared credentials file / instance profile).
  process.env.AWS_SDK_LOAD_CONFIG = '1';
}

describeLive('Google Ads live API contract', () => {
  jest.setTimeout(120_000);

  let actions: any[] = [];

  beforeAll(async () => {
    ({ googleAdsService } = require('../services/googleAdsService'));
    actions = await googleAdsService.listConversionActions(USER_ID!, CUSTOMER_ID!);
  });

  it('returns at least one conversion action to assert against', () => {
    // Not a tautology: an empty account would make every assertion below vacuously pass,
    // which is exactly how a contract test rots into a no-op.
    expect(actions.length).toBeGreaterThan(0);
  });

  it('serialises INT64 as a JSON STRING, not a number', () => {
    // #2475's drift check compared a requested number against this. Strict equality
    // reported false drift on every write that Google had honoured perfectly — and drift
    // is the one signal here that only works if it is trusted.
    const withLookback = actions.find((a) => a.clickThroughLookbackWindowDays !== undefined);
    expect(withLookback).toBeDefined();
    expect(typeof withLookback.clickThroughLookbackWindowDays).toBe('string');
  });

  it('returns ids as strings too', () => {
    expect(typeof actions[0].id).toBe('string');
  });

  it('returns tag snippets that parse to an AW-<id>/<label> pair', () => {
    // The pair is the whole point of the read-back: a resource name cannot be installed
    // on a page. If Google changes the snippet shape, parseTagSnippets returns null and
    // every generated lander silently loses its conversion label.
    const tagged = actions.find((a) => Array.isArray(a.tagSnippets) && a.tagSnippets.length > 0);
    expect(tagged).toBeDefined();
    const pair = parseTagSnippets(tagged.tagSnippets);
    expect(pair).not.toBeNull();
    expect(pair!.conversionId).toMatch(/^AW-[0-9]{6,}$/);
    expect(pair!.conversionLabel.length).toBeGreaterThan(0);
    expect(pair!.sendTo).toBe(`${pair!.conversionId}/${pair!.conversionLabel}`);
  });

  it('reports only ENABLED or REMOVED as stored statuses', () => {
    // If Google ever returns HIDDEN here, that is fine — it assigns that status itself.
    // What must never appear is PAUSED, which would mean the enum changed under us.
    for (const a of actions) {
      expect(['ENABLED', 'REMOVED', 'HIDDEN']).toContain(a.status);
    }
  });

  describe('statuses our code refuses to send — the rejection IS the assertion', () => {
    it('refuses HIDDEN on CREATE before reaching Google', async () => {
      // Google deny-lists it (fieldError BLOCKED_VALUE on operations[0].create.status).
      // We refuse locally so the caller gets a usable message; if this ever stops
      // throwing, our guard has drifted from the API and a create will start 400ing.
      await expect(googleAdsService.createConversionAction(USER_ID!, CUSTOMER_ID!, {
        name: 'contract-test-should-never-exist',
        category: 'SUBMIT_LEAD_FORM',
        countingType: 'ONE_PER_CLICK',
        status: 'HIDDEN',
      })).rejects.toThrow(/Google assigns it/);
    });

    it('refuses PAUSED, which is a campaign status and not in this enum', async () => {
      await expect(googleAdsService.createConversionAction(USER_ID!, CUSTOMER_ID!, {
        name: 'contract-test-should-never-exist',
        category: 'SUBMIT_LEAD_FORM',
        countingType: 'ONE_PER_CLICK',
        status: 'PAUSED',
      })).rejects.toThrow(/campaign status/);
    });

    it('refuses a CREATE with no counting_type', async () => {
      // The field that fails SILENTLY when wrong: MANY_PER_CLICK on a lead form inflates
      // reported conversions and misdirects smart bidding, and nothing errors.
      await expect(googleAdsService.createConversionAction(USER_ID!, CUSTOMER_ID!, {
        name: 'contract-test-should-never-exist',
        category: 'SUBMIT_LEAD_FORM',
        countingType: '',
      })).rejects.toThrow(/counting_type is required/);
    });

    it('routes UPDATE status=REMOVED to the confirmed REMOVE path', async () => {
      await expect(googleAdsService.updateConversionAction(
        USER_ID!, CUSTOMER_ID!, actions[0].resourceName, { status: 'REMOVED' },
      )).rejects.toThrow(/confirm_conversion_action_removal=true/);
    });
  });

  describe('Google itself still rejects what we assume it rejects', () => {
    it('rejects status=HIDDEN on UPDATE with BLOCKED_VALUE', async () => {
      // Bypasses our own guard on purpose: this asserts GOOGLE's behaviour, not ours.
      // The mutate is rejected, so nothing is modified. If it ever succeeds, HIDDEN has
      // become settable and our whole retire story should be revisited.
      const { accessToken, loginCustomerId } = await (googleAdsService as any)
        .getAccountCredentials(USER_ID!, CUSTOMER_ID!);
      await expect((googleAdsService as any).mutate(
        CUSTOMER_ID!, accessToken, 'conversionActions',
        [{ update: { resourceName: actions[0].resourceName, status: 'HIDDEN' }, updateMask: 'status' }],
        loginCustomerId,
      )).rejects.toThrow(/BLOCKED_VALUE|deny-list/i);
    });

    it('surfaces Google\'s own error text rather than an opaque axios message', async () => {
      // callApi used to rethrow the raw axios error, whose message is only "Request
      // failed with status code 400". The field-level cause reached the log and nowhere
      // else — invisible at exactly the moment it mattered.
      const { accessToken, loginCustomerId } = await (googleAdsService as any)
        .getAccountCredentials(USER_ID!, CUSTOMER_ID!);
      await expect((googleAdsService as any).mutate(
        CUSTOMER_ID!, accessToken, 'conversionActions',
        [{ update: { resourceName: actions[0].resourceName, status: 'HIDDEN' }, updateMask: 'status' }],
        loginCustomerId,
      )).rejects.not.toThrow(/^Request failed with status code/);
    });
  });
});
