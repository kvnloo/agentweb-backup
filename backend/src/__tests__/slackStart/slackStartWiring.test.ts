/**
 * ENG-2782 S1 — production adapters behind the Slack-start service: the real
 * user, CRM lead and brand-build calls. Each must be idempotent because the
 * service retries provisioning on a same-key replay.
 */
jest.mock('../../services/db', () => ({
  userDb: { createUser: jest.fn(), getUserByIdConsistent: jest.fn(), getUserByEmail: jest.fn(), updateUser: jest.fn() },
  crmDb: { getLeadListById: jest.fn(), createLead: jest.fn(), updateLead: jest.fn() },
}));
jest.mock('../../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['chat'], allowedSkills: [] }),
  DEFAULT_PAGES: ['chat'],
}));
jest.mock('../../services/onboardingBrandBuildService', () => ({
  claimBrandBuildRun: jest.fn(),
  triggerBrandBuildForUser: jest.fn().mockResolvedValue(undefined),
}));

import { buildProductionSlackStartDeps, SLACK_START_DISABLED_PASSWORD } from '../../services/slackStart/slackStartWiring';
const { userDb, crmDb } = require('../../services/db');
const brand = require('../../services/onboardingBrandBuildService');

const env = { SLACK_START_LEAD_LIST_ID: 'list-1', JWT_SECRET: 'jwt', SLACK_START_ALLOWED_ORIGINS: 'https://partner.example, https://x.example' };
const deps = () => buildProductionSlackStartDeps(env);
const lead = { leadId: 'slackstart-i1', intakeId: 'i1', email: 'sam@acme.co', website: 'https://acme.co', domain: 'acme.co', utm: { source: 'linkedin' } };

beforeEach(() => jest.clearAllMocks());

describe('createUser', () => {
  it('creates a customer account with a password that can never match (claim = prove the mailbox)', async () => {
    userDb.createUser.mockResolvedValue({ userId: 'u1' });
    await expect(deps().createUser({ userId: 'u1', email: 'sam@acme.co' })).resolves.toBe('created');
    const [email, userId, password, isOAuth, isAdmin, roles] = userDb.createUser.mock.calls[0];
    expect([email, userId, isOAuth, isAdmin, roles]).toEqual(['sam@acme.co', 'u1', false, false, ['customer']]);
    expect(password).toBe(SLACK_START_DISABLED_PASSWORD);
    expect(password.startsWith('$2')).toBe(false); // not a bcrypt hash → bcrypt.compare can never succeed
    expect(userDb.updateUser).toHaveBeenCalledWith('u1', expect.objectContaining({ subscriptionType: 'Free', allowedPages: ['chat'] }));
  });

  it('treats a retry of its own pre-minted id as already created', async () => {
    userDb.createUser.mockRejectedValue(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
    userDb.getUserByIdConsistent.mockResolvedValue({ userId: 'u1', email: 'sam@acme.co' });
    await expect(deps().createUser({ userId: 'u1', email: 'sam@acme.co' })).resolves.toBe('created');
  });
});

describe('writeLead', () => {
  beforeEach(() => crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'owner-1' }));

  it('writes one lead into the configured list under a deterministic id', async () => {
    crmDb.createLead.mockResolvedValue({ leadId: 'slackstart-i1' });
    await expect(deps().writeLead(lead)).resolves.toEqual({ leadId: 'slackstart-i1' });
    const [listId, data] = crmDb.createLead.mock.calls[0];
    expect(listId).toBe('list-1');
    expect(data).toMatchObject({
      leadId: 'slackstart-i1',
      failIfExists: true,
      email: 'sam@acme.co',
      website: 'https://acme.co',
      domain: 'acme.co',
      userId: 'owner-1',
      utmSource: 'linkedin',
      customFields: { signupSource: 'slack_start', slackStartIntakeId: 'i1', utm_source: 'linkedin' },
    });
  });

  it('is idempotent: an existing row for the same id, or the same email, is adopted', async () => {
    crmDb.createLead.mockRejectedValueOnce(Object.assign(new Error('exists'), { leadAlreadyExists: true }));
    await expect(deps().writeLead(lead)).resolves.toEqual({ leadId: 'slackstart-i1' });
    crmDb.createLead.mockRejectedValueOnce(Object.assign(new Error('dup'), { duplicateEmail: true, existingLead: { leadId: 'older-lead' } }));
    await expect(deps().writeLead(lead)).resolves.toEqual({ leadId: 'older-lead' });
  });

  it('fails loudly when the lead list is not configured or missing', async () => {
    await expect(buildProductionSlackStartDeps({ JWT_SECRET: 'x' }).writeLead(lead)).rejects.toThrow(/SLACK_START_LEAD_LIST_ID/);
    crmDb.getLeadListById.mockResolvedValue(null);
    await expect(deps().writeLead(lead)).rejects.toThrow(/not found/);
  });

  it('mirrors answers into the lead as a key-merged custom-field patch', async () => {
    await deps().updateLeadAnswers('slackstart-i1', { slackStartRole: 'founder' });
    expect(crmDb.updateLead).toHaveBeenCalledWith('list-1', 'slackstart-i1', { customFields: { slackStartRole: 'founder' }, customFieldsKeyMerge: true });
  });
});

describe('triggerBrandBuild', () => {
  it('claims the brand-dna axis and fires the build without Slack Connect', async () => {
    brand.claimBrandBuildRun.mockResolvedValue({ brandBuildStartedAt: 'T0' });
    await deps().triggerBrandBuild('u1');
    expect(brand.triggerBrandBuildForUser).toHaveBeenCalledWith('u1', { expectedStartedAt: 'T0', skipSlackConnect: true });
  });

  it('does nothing when another run already holds the claim', async () => {
    brand.claimBrandBuildRun.mockResolvedValue(null);
    await deps().triggerBrandBuild('u1');
    expect(brand.triggerBrandBuildForUser).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it('prefers a dedicated token secret, parses the origin allowlist and rate limits', () => {
    expect(deps().tokenSecret).toBe('jwt');
    expect(buildProductionSlackStartDeps({ ...env, SLACK_START_TOKEN_SECRET: 'own' }).tokenSecret).toBe('own');
    expect(deps().allowedOrigins).toEqual(['https://partner.example', 'https://x.example']);
    expect(deps().rateLimits).toEqual({ ipPerHour: 10, domainPerDay: 5 });
    expect(buildProductionSlackStartDeps({ SLACK_START_RATE_IP_PER_HOUR: '3', SLACK_START_RATE_DOMAIN_PER_DAY: '2' }).rateLimits).toEqual({ ipPerHour: 3, domainPerDay: 2 });
  });
});
