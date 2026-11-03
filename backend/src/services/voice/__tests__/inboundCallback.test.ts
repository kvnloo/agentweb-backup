jest.mock('../../db', () => ({ orgDb: { getOrgById: jest.fn(), listHotLeadCallNumbers: jest.fn() } }));
import { orgDb } from '../../db';
import { setHotLeadCallEnabledOverride } from '../hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../hotLeadCallEntitlement';
import { resetInboundNumberIndexForTests } from '../inboundNumberIndex';
import { hotLeadCallConfigOf } from '../../hotLeadCallConfig';
import { isAcceptingMember, nextInboundMember, resolveInboundContext, resolveInboundContextForOrg, triedMembersOf } from '../inboundCallback';
import { teamMember, referenceMember } from '../../../__tests__/helpers/hotLeadCallFixtures';

const mock = (fn: unknown) => fn as jest.Mock;
const NUMBER = '+14155550111';
const stored = {
  enabled: true,
  team: [teamMember('+14155550100')],
  twilioNumber: NUMBER,
  announcedName: 'Acme Plumbing',
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

beforeEach(() => {
  jest.resetAllMocks();
  resetInboundNumberIndexForTests();
  setHotLeadCallEnabledOverride(true);
  setHotLeadCallEntitledOverride(true);
  mock(orgDb.listHotLeadCallNumbers).mockResolvedValue([{ orgId: 'org-a', twilioNumber: NUMBER }]);
  mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', ownerUserId: 'owner-a', hotLeadCall: stored });
});
afterEach(() => {
  setHotLeadCallEnabledOverride(null);
  setHotLeadCallEntitledOverride(null);
});

describe('resolveInboundContext', () => {
  it('resolves the org by the dialled number, reading it back with a consistent read', async () => {
    await expect(resolveInboundContext(NUMBER)).resolves.toMatchObject({ orgId: 'org-a', ownerUserId: 'owner-a', config: { announcedName: 'Acme Plumbing' } });
    expect(orgDb.getOrgById).toHaveBeenCalledWith('org-a', undefined, true);
  });

  it.each([
    ['an unknown number', () => mock(orgDb.listHotLeadCallNumbers).mockResolvedValue([])],
    ['the kill switch off', () => setHotLeadCallEnabledOverride(false)],
    ['an org that no longer exists', () => mock(orgDb.getOrgById).mockResolvedValue(undefined)],
    ['a disabled config', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', ownerUserId: 'o', hotLeadCall: { ...stored, enabled: false } })],
    ['an invalid config', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', ownerUserId: 'o', hotLeadCall: { ...stored, team: [] } })],
    ['a number the org has since replaced (stale index)', () => mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', ownerUserId: 'o', hotLeadCall: { ...stored, twilioNumber: '+14155550122' } })],
    ['a plan without the feature', () => setHotLeadCallEntitledOverride(false)],
  ])('returns null for %s', async (_what, arrange) => {
    arrange();
    await expect(resolveInboundContext(NUMBER)).resolves.toBeNull();
  });

  it.each([[undefined], [''], ['4155550111'], ['+0123']])('returns null for the dialled value %j without looking anything up', async (dialled) => {
    await expect(resolveInboundContext(dialled)).resolves.toBeNull();
    expect(orgDb.listHotLeadCallNumbers).not.toHaveBeenCalled();
  });

  it('lets a failing lookup propagate so the route can refuse the call', async () => {
    mock(orgDb.listHotLeadCallNumbers).mockRejectedValue(new Error('down'));
    await expect(resolveInboundContext(NUMBER)).rejects.toThrow('down');
  });
});

describe('resolveInboundContextForOrg', () => {
  it('resolves from the org id alone and applies the same gates', async () => {
    await expect(resolveInboundContextForOrg('org-a')).resolves.toMatchObject({ orgId: 'org-a' });
    setHotLeadCallEnabledOverride(false);
    await expect(resolveInboundContextForOrg('org-a')).resolves.toBeNull();
    setHotLeadCallEnabledOverride(true);
    setHotLeadCallEntitledOverride(false);
    await expect(resolveInboundContextForOrg('org-a')).resolves.toBeNull();
    setHotLeadCallEntitledOverride(true);
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', ownerUserId: 'o', hotLeadCall: { ...stored, enabled: false } });
    await expect(resolveInboundContextForOrg('org-a')).resolves.toBeNull();
  });
});

describe('resolveInboundContextForOrg refusals', () => {
  it.each([
    ['an org without an owner', { orgId: 'org-a', ownerUserId: '', hotLeadCall: stored }],
    ['an org record whose id differs from the signed one', { orgId: 'org-x', ownerUserId: 'owner-a', hotLeadCall: stored }],
    ['a config without a caller number', { orgId: 'org-a', ownerUserId: 'owner-a', hotLeadCall: { ...stored, enabled: false, twilioNumber: undefined } }],
    [ 'no org', undefined ],
  ])('returns null for %s', async (_what, org) => {
    mock(orgDb.getOrgById).mockResolvedValue(org);
    await expect(resolveInboundContextForOrg('org-a')).resolves.toBeNull();
  });
});

describe('triedMembersOf', () => {
  it.each([
    ['', []],
    ['maaaaaaa', ['maaaaaaa']],
    ['maaaaaaa,mbbbbbbb', ['maaaaaaa', 'mbbbbbbb']],
  ])('parses %j', (raw, expected) => expect(triedMembersOf(raw)).toEqual(expected));

  it.each([
    ['not a string', undefined], ['an array', ['maaaaaaa']], ['a bad id', 'nope'], ['a duplicate', 'maaaaaaa,maaaaaaa'],
    ['an empty entry', 'maaaaaaa,'], ['more than the largest attempt cap (5)', 'maaaaaaa,mbbbbbbb,mccccccc,mddddddd,meeeeeee,mfffffff'],
  ])('rejects %s', (_what, raw) => expect(triedMembersOf(raw)).toBeNull());
});

describe('nextInboundMember', () => {
  // 2026-10-19 is a Monday; 17:00Z is 12:00 in Chicago.
  const noon = new Date('2026-10-19T17:00:00.000Z');
  const config = hotLeadCallConfigOf({
    ...stored,
    maxAttemptsPerLead: 2,
    team: [referenceMember('a', '09:00', '11:00'), referenceMember('b', '09:00', '17:00'), referenceMember('c', '09:00', '17:00'), referenceMember('d', '09:00', '17:00')],
  })!;

  it('picks the first member in priority order who is inside their window now', () => {
    expect(nextInboundMember(config, [], noon)?.id).toBe('mbbbbbbb');
  });
  it('skips members already tried and stops at maxAttemptsPerLead', () => {
    expect(nextInboundMember(config, ['mbbbbbbb'], noon)?.id).toBe('mccccccc');
    expect(nextInboundMember(config, ['mbbbbbbb', 'mccccccc'], noon)).toBeNull();
  });
  it('returns null outside the calling hours', () => {
    expect(nextInboundMember(config, [], new Date('2026-10-19T03:00:00.000Z'))).toBeNull();
  });
  it('does not ring an unverified member', () => {
    const unverified = hotLeadCallConfigOf({ ...stored, enabled: false, team: [teamMember('+14155550100', { verifiedAt: undefined })] })!;
    expect(nextInboundMember(unverified, [], noon)).toBeNull();
  });
});

describe('isAcceptingMember', () => {
  const config = hotLeadCallConfigOf({ ...stored, team: [teamMember('+14155550100'), teamMember('+14155550101', { id: 'mbbbbbbb', verifiedAt: undefined })] })!;
  it('is true only for a verified member of the team', () => {
    expect(isAcceptingMember(config, 'maaaaaaa')).toBe(true);
    expect(isAcceptingMember(config, 'mbbbbbbb')).toBe(false);
    expect(isAcceptingMember(config, 'mzzzzzzz')).toBe(false);
    expect(isAcceptingMember(config, undefined)).toBe(false);
  });
});
