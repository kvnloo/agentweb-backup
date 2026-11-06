/**
 * ENG-2782 S1 — the Slack-start intake fires the brand build at step 1 but must
 * provision Slack Connect only at completion (after the visitor finished the
 * wizard). The brand build's own WS3 side effect would otherwise race the
 * completion call once SLACK_CONNECT_ENABLED is on and invite twice.
 */
jest.mock('../../services/brandGuidelinesPopulation', () => ({ populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/db', () => ({ userDb: { getUserById: jest.fn(), updateUser: jest.fn() } }));
jest.mock('../../services/slackConnectService', () => ({ provisionOnboardingSlackConnect: jest.fn().mockResolvedValue({ status: 'disabled' }) }));
jest.mock('../../services/customerChannelPolicy', () => ({ hasWhatsApp: () => false }));
jest.mock('../../services/onboardingTelemetry', () => ({
  recordOnboardingEvent: jest.fn().mockResolvedValue(undefined),
  recordOnboardingFailure: jest.fn().mockResolvedValue(undefined),
  ONBOARDING_TELEMETRY_EVENTS: { brandScrapeStarted: 'x' },
}));

import { triggerBrandBuildForUser } from '../../services/onboardingBrandBuildService';
const { userDb } = require('../../services/db');
const { provisionOnboardingSlackConnect } = require('../../services/slackConnectService');

const flush = () => new Promise((r) => setImmediate(r));
const deps = {
  createChatSession: jest.fn().mockRejectedValue(new Error('stop here')),
  generateSessionResponse: jest.fn(),
  ensureBrandLogo: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'sam@acme.co', companyUrl: 'https://acme.co' });
  userDb.updateUser.mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

it('still provisions Slack Connect from the brand build by default (existing WS3 behavior)', async () => {
  await triggerBrandBuildForUser('u1', deps);
  await flush();
  expect(provisionOnboardingSlackConnect).toHaveBeenCalledTimes(1);
});

it('does not provision Slack Connect when the caller owns that step (skipSlackConnect)', async () => {
  await triggerBrandBuildForUser('u1', { ...deps, skipSlackConnect: true });
  await flush();
  expect(provisionOnboardingSlackConnect).not.toHaveBeenCalled();
});
