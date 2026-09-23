import { emptyBrandFields, fillEmptyBrandGuidelines, mapManageBrandUpdate } from '../utils/brandGuidelines';
import { planBrandGuidelinesPopulation, applyBrandGuidelinesPopulation } from '../services/brandGuidelinesPopulation';
import { userDb, orgDb } from '../services/db';
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmailConsistent: jest.fn(), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
}));
const users = userDb as jest.Mocked<typeof userDb>;
const orgs = orgDb as jest.Mocked<typeof orgDb>;
const strategy = { businessOverview: 'IT management', tagline: 'Easy IT', toneOfVoice: 'Direct',
  icp: [{ title: 'IT teams', description: 'IT teams at growing companies', valueProposition: 'Manage endpoints easily' }] };
const source = { companyName: 'NinjaOne', productDomain: 'ninjaone.com' };

it('fills all seven empty fields from existing strategy and onboarding facts', () => {
  const result = fillEmptyBrandGuidelines({ brandData: { brandName: '  ', keyMessages: [] } }, strategy, source);
  expect(result.guidelines.brandData).toEqual({ brandName: 'NinjaOne', domain: 'ninjaone.com',
    tagline: 'Easy IT', toneOfVoice: 'Direct', targetAudience: 'IT teams at growing companies',
    valueProposition: 'Manage endpoints easily', keyMessages: ['Manage endpoints easily'] });
  expect(emptyBrandFields(result.guidelines)).toEqual([]);
});

it('preserves every non-empty field, founders, attachments and unknown metadata; reruns are no-ops', () => {
  const filled = fillEmptyBrandGuidelines({}, strategy, source).guidelines;
  const existing = { ...filled, attachments: [{ key: 'logo' }], custom: 'keep',
    brandData: { ...filled.brandData, founders: [{ name: 'Founder' }], logoUrl: 'logo',
      brandName: 'My chosen brand', keyMessages: ['My copy'] } };
  const result = fillEmptyBrandGuidelines(existing, { ...strategy, tagline: 'Replacement' }, { companyName: 'Replacement' });
  expect(result.guidelines).toBe(existing);
  expect(result.filledFields).toEqual([]);
});

it('fills partially empty records without deleting founders or attachments', () => {
  const existing = { rev: 'old-revision', attachments: [{ key: 'logo' }], brandData: { brandName: 'Custom', founders: [{ name: 'A' }] } };
  const result = fillEmptyBrandGuidelines(existing, strategy, source);
  expect(result.guidelines.brandData.brandName).toBe('Custom');
  expect(result.guidelines.brandData.founders).toEqual(existing.brandData.founders);
  expect(result.guidelines.attachments).toBe(existing.attachments);
  expect(result.guidelines.rev).not.toBe(existing.rev);
  expect(existing.brandData).not.toHaveProperty('tagline');
});

it('ignores malformed external source elements and never invents absent copy', () => {
  const result = fillEmptyBrandGuidelines({}, { icp: [null, 2, { title: {}, valueProposition: true }],
    keyMessages: [null, {}, 1], businessOverview: true }, { companyName: {} });
  expect(result.filledFields).toEqual([]);
  expect(emptyBrandFields(result.guidelines)).toHaveLength(7);
  expect(fillEmptyBrandGuidelines({}, { icp: 'bad' }, {}).filledFields).toEqual([]);
});

it('maps only supplied MCP fields and allowlists visual identity without accepting founders/attachments', () => {
  expect(mapManageBrandUpdate({ mission: '', key_messages: [], visual_identity: {
    primaryColor: '#123456', founders: [], attachments: [], brandName: 'Injected',
  } })).toEqual({ valueProposition: '', keyMessages: [], primaryColor: '#123456' });
});

beforeEach(() => jest.clearAllMocks());
function mockUser(user: any) {
  users.getUserById.mockResolvedValue(user);
  users.getUserByEmailConsistent.mockResolvedValue(user);
}

it('protects solo writes with the complete brand snapshot condition', async () => {
  const user: any = { userId: 'owner', email: 'owner@example.com', ...source, marketStrategy: strategy,
    brandGuidelines: { brandData: { brandName: 'Custom' }, attachments: [{ key: 'logo' }] } };
  mockUser(user);
  const plan = await planBrandGuidelinesPopulation('owner');
  await applyBrandGuidelinesPopulation(plan);
  expect(users.updateUser).toHaveBeenCalledWith('owner', expect.objectContaining({
    brandGuidelines: expect.objectContaining({ attachments: user.brandGuidelines.attachments }),
  }), { condition: { expression: 'attribute_exists(#identity) AND #brand = :before', names: { '#brand': 'brandGuidelines', '#identity': 'email' },
    values: { ':before': user.brandGuidelines } } });
});

it('uses the org brand/strategy and owner identity, never the member identity', async () => {
  const member: any = { userId: 'member', email: 'member@example.com', orgId: 'org', companyName: 'WRONG' };
  const owner: any = { userId: 'owner', email: 'owner@example.com', orgId: 'org', ...source };
  users.getUserById.mockImplementation(async id => id === 'member' ? member : owner);
  users.getUserByEmailConsistent.mockImplementation(async email => email === member.email ? member : owner);
  orgs.getOrgById.mockResolvedValue({ orgId: 'org', ownerUserId: 'owner', marketStrategy: strategy,
    brandGuidelines: { brandData: {}, attachments: [{ key: 'org-logo' }] } } as any);
  const plan = await planBrandGuidelinesPopulation('member');
  await applyBrandGuidelinesPopulation(plan);
  expect(orgs.updateOrg).toHaveBeenCalledWith('org', expect.objectContaining({ brandGuidelines:
    expect.objectContaining({ brandData: expect.objectContaining({ brandName: 'NinjaOne' }) }) }), expect.anything());
  expect(users.updateUser).not.toHaveBeenCalled();
});

it('keeps the owner fallback authoritative when the org has no brand', async () => {
  mockUser({ userId: 'owner', email: 'owner@example.com', orgId: 'org', ...source, marketStrategy: strategy });
  orgs.getOrgById.mockResolvedValue({ orgId: 'org', ownerUserId: 'owner' } as any);
  await applyBrandGuidelinesPopulation(await planBrandGuidelinesPopulation('owner'));
  expect(orgs.updateOrg).not.toHaveBeenCalled();
  expect(users.updateUser).toHaveBeenCalledWith('owner', expect.anything(), expect.objectContaining({
    condition: expect.objectContaining({ expression: 'attribute_exists(#identity) AND attribute_not_exists(#brand)' }),
  }));
});

it('propagates a concurrent edit conflict without retrying stale data', async () => {
  mockUser({ userId: 'owner', email: 'owner@example.com', ...source });
  users.updateUser.mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));
  await expect(applyBrandGuidelinesPopulation(await planBrandGuidelinesPopulation('owner')))
    .rejects.toThrow('ConditionalCheckFailedException');
  expect(users.updateUser).toHaveBeenCalledTimes(1);
});


it('refuses a stale user-index entry whose email has been reassigned', async () => {
  users.getUserById.mockResolvedValue({ userId: 'old', email: 'reused@example.com' });
  users.getUserByEmailConsistent.mockResolvedValue({ userId: 'new', email: 'reused@example.com' });
  await expect(planBrandGuidelinesPopulation('old')).rejects.toThrow('user old missing');
  expect(users.updateUser).not.toHaveBeenCalled();
});


it('creates the canonical brand shape without inventing unavailable copy', () => {
  const result = fillEmptyBrandGuidelines(undefined, {}, source);
  expect(result.filledFields).toEqual(['brandName', 'domain']);
  expect(result.guidelines.brandData).toMatchObject({ brandName: 'NinjaOne', domain: 'ninjaone.com',
    tagline: '', primaryColor: '', fontFamily: '', brandValues: [], founders: [], keyMessages: [] });
  expect(result.guidelines.attachments).toEqual([]);
});
