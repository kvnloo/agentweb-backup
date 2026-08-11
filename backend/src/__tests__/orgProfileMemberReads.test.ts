/**
 * ENG-927 follow-through — the NON-settings read paths.
 *
 * The settings GETs now fall back to the org owner's record when the org was
 * created without copying the profile over. The other org-aware readers still
 * used the soft form (`if (org && org.brandGuidelines)`), which falls back to
 * the CALLER's own record — correct for the owner, empty for a member. That
 * left a member of an un-copied org seeing their brand on the Brand Guidelines
 * page while Emma answered "No brand guidelines found" and landing-page
 * generation had no logo. Verified live on the ENG-927 preview before this fix:
 * settings returned the owner's brand and `readBrandGuidelines` returned
 * `exists: false` for the same member.
 */

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();

jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a), updateUser: jest.fn() },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a), updateOrg: jest.fn() },
  taskDb: {},
  taskTemplateDb: {},
  accountMemoryDb: {},
}));

import { AgentModeService } from '../services/agentModeService';
import {
  resolveBrandGuidelinesForLoadedUser,
  resolveBrandGuidelinesForUser,
} from '../services/agentMode/brandLogo';

const ORG_ID = 'org-1';
const OWNER_ID = 'owner-u';
const MEMBER_ID = 'member-u';

const ownerBrand = {
  brandData: { brandName: 'Acme', tagline: 'We widget' },
  attachments: [{ type: 'logo', url: 'https://cdn/logo.png', key: 'logo-1' }],
};
const ownerStrategy = {
  businessOverview: 'We sell widgets',
  competitors: [{ name: 'Widgetco' }],
  icp: [{ title: 'Ops leads' }],
};

/** Exactly what orgDb.createOrg writes — structural fields only. */
const unCopiedOrg = { orgId: ORG_ID, ownerUserId: OWNER_ID, name: 'Acme', maxMembers: 5 };

const ownerRecord = {
  userId: OWNER_ID,
  email: 'owner@test.com',
  orgId: ORG_ID,
  orgRole: 'owner',
  brandGuidelines: ownerBrand,
  marketStrategy: ownerStrategy,
};
const memberRecord = {
  userId: MEMBER_ID,
  email: 'member@test.com',
  orgId: ORG_ID,
  orgRole: 'member',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

describe("Emma's readBrandGuidelines — org member on an un-copied org", () => {
  it("serves the OWNER's brand instead of 'No brand guidelines found'", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === MEMBER_ID ? memberRecord : ownerRecord
    );
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const res = await new AgentModeService().readBrandGuidelines(MEMBER_ID);

    expect(res.exists).toBe(true);
    expect(res.brandData).toEqual(ownerBrand.brandData);
    expect(res.attachments).toEqual(ownerBrand.attachments);
  });

  it('still prefers the org record once it has been populated', async () => {
    const orgBrand = { brandData: { brandName: 'Acme Org' }, attachments: [] };
    mockGetUserById.mockResolvedValue(memberRecord);
    mockGetOrgById.mockResolvedValue({ ...unCopiedOrg, brandGuidelines: orgBrand });

    const res = await new AgentModeService().readBrandGuidelines(MEMBER_ID);

    expect(res.brandData).toEqual(orgBrand.brandData);
    // The org record answered — no owner lookup needed.
    expect(mockGetUserById).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the owner when the caller IS the owner', async () => {
    mockGetUserById.mockResolvedValue(ownerRecord);
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const res = await new AgentModeService().readBrandGuidelines(OWNER_ID);

    expect(res.exists).toBe(true);
    expect(res.brandData).toEqual(ownerBrand.brandData);
    expect(mockGetUserById).toHaveBeenCalledTimes(1);
  });

  it('reports the empty state when nobody has a brand', async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === MEMBER_ID ? memberRecord : { ...ownerRecord, brandGuidelines: undefined }
    );
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const res = await new AgentModeService().readBrandGuidelines(MEMBER_ID);

    expect(res.exists).toBe(false);
  });
});

describe("Emma's readMarketStrategy — org member on an un-copied org", () => {
  it("serves the OWNER's market strategy", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === MEMBER_ID ? memberRecord : ownerRecord
    );
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const res = await new AgentModeService().readMarketStrategy(MEMBER_ID);

    expect(res.exists).toBe(true);
    expect(res.formattedContent).toContain('Widgetco');
  });

  it('reports the empty state when nobody has a strategy', async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === MEMBER_ID ? memberRecord : { ...ownerRecord, marketStrategy: undefined }
    );
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const res = await new AgentModeService().readMarketStrategy(MEMBER_ID);

    expect(res.exists).toBe(false);
  });
});

describe('brandLogo brand resolution — org member on an un-copied org', () => {
  it("resolves the OWNER's brand (so generated creatives keep the logo)", async () => {
    mockGetOrgById.mockResolvedValue(unCopiedOrg);
    mockGetUserById.mockResolvedValue(ownerRecord);

    const brand = await resolveBrandGuidelinesForLoadedUser(memberRecord as any);

    expect(brand?.brandData?.brandName).toBe('Acme');
    expect(mockGetUserById).toHaveBeenCalledWith(OWNER_ID);
  });

  it('prefers a populated org record', async () => {
    const orgBrand = { brandData: { brandName: 'Acme Org' } };
    mockGetOrgById.mockResolvedValue({ ...unCopiedOrg, brandGuidelines: orgBrand });

    const brand = await resolveBrandGuidelinesForLoadedUser(memberRecord as any);

    expect(brand?.brandData?.brandName).toBe('Acme Org');
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('leaves a solo user untouched and reads no org', async () => {
    const solo = { userId: 'solo', brandGuidelines: ownerBrand };

    const brand = await resolveBrandGuidelinesForLoadedUser(solo as any);

    expect(brand?.brandData?.brandName).toBe('Acme');
    expect(mockGetOrgById).not.toHaveBeenCalled();
  });

  it('resolves by userId for the member too', async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === MEMBER_ID ? memberRecord : ownerRecord
    );
    mockGetOrgById.mockResolvedValue(unCopiedOrg);

    const brand = await resolveBrandGuidelinesForUser(MEMBER_ID);

    expect(brand?.brandData?.brandName).toBe('Acme');
  });
});
