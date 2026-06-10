import {
  canViewItem, canEditItem, canManageOrgFeature, isAlwaysOnFeature,
  isFeatureEffectivelyEnabled,
  defaultEnabledFor, defaultShareSettings,
  Feature,
  listOrgVisibleItems, MEMBER_FANOUT_CAP,
} from "../services/orgShareService";
import type { Organization } from "../services/db";

const orgA: Organization = {
  orgId: "org-A", ownerUserId: "u-admin", name: "A",
  shareSettings: {
    knowledgeBase:     { enabled: false, editors: [] },
    htmlTemplates:     { enabled: true,  editors: ["u-editor"] },
    landingPages:      { enabled: false, editors: [] },
    workPlans:         { enabled: true,  editors: [] },
    skills:            { enabled: false, editors: [] },
    brandGuidelines:   { editors: ["u-bg-editor"] },
    marketingStrategy: { editors: [] },
  },
} as unknown as Organization;

const owner   = { userId: "u-owner",  orgId: "org-A", orgRole: "member" as const };
const admin   = { userId: "u-admin",  orgId: "org-A", orgRole: "owner"  as const };
const editor  = { userId: "u-editor", orgId: "org-A", orgRole: "member" as const };
const member  = { userId: "u-member", orgId: "org-A", orgRole: "member" as const };
const other   = { userId: "u-other",  orgId: "org-B", orgRole: "member" as const };
const solo    = { userId: "u-solo" };

const item = { userId: "u-owner" };
const ownerOrgId = "org-A";

describe("canViewItem", () => {
  it("owner can view their own item regardless of any flag", () => {
    expect(canViewItem(item, owner, null, undefined, "htmlTemplates")).toBe(true);
    expect(canViewItem(item, owner, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
  it("toggleable feature: enabled=true allows same-org member", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "htmlTemplates")).toBe(true);
  });
  it("toggleable feature: enabled=false blocks same-org member", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "knowledgeBase")).toBe(false);
  });
  it("always-on feature: brandGuidelines view always allowed within org", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
    expect(canViewItem(item, member, orgA, ownerOrgId, "marketingStrategy")).toBe(true);
  });
  it("different-org user blocked from all features", () => {
    expect(canViewItem(item, other, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
    expect(canViewItem(item, other, orgA, ownerOrgId, "brandGuidelines")).toBe(false);
  });
  it("solo user blocked from all non-own access", () => {
    expect(canViewItem(item, solo as any, null, undefined, "htmlTemplates")).toBe(false);
  });
  it("editor sees other-member items even when sharing is disabled", () => {
    // landingPages has enabled=false, no editors in orgA — extend the org
    // for this scenario with an editor entry.
    const orgWithEditor = {
      ...orgA,
      shareSettings: {
        ...orgA.shareSettings!,
        landingPages: { enabled: false, editors: ["u-editor"] },
      },
    };
    expect(canViewItem(item, editor, orgWithEditor as any, ownerOrgId, "landingPages")).toBe(true);
  });
  it("org admin sees all items even when sharing is disabled", () => {
    expect(canViewItem(item, admin, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
});

describe("canManageOrgFeature", () => {
  it("solo user can always manage", () => {
    expect(canManageOrgFeature(solo as any, null, "htmlTemplates")).toBe(true);
  });
  it("org admin can manage regardless of toggle", () => {
    const orgOff = { ...orgA, shareSettings: { ...orgA.shareSettings!, landingPages: { enabled: false, editors: [] } } };
    expect(canManageOrgFeature(admin, orgOff as any, "landingPages")).toBe(true);
  });
  it("listed editor can manage even when feature.enabled=false", () => {
    const orgOff = { ...orgA, shareSettings: { ...orgA.shareSettings!, landingPages: { enabled: false, editors: ["u-editor"] } } };
    expect(canManageOrgFeature(editor, orgOff as any, "landingPages")).toBe(true);
  });
  it("non-editor org member blocked", () => {
    expect(canManageOrgFeature(member, orgA, "htmlTemplates")).toBe(false);
  });
});

describe("isFeatureEffectivelyEnabled", () => {
  it("plain member: follows enabled toggle", () => {
    expect(isFeatureEffectivelyEnabled(member, orgA, "htmlTemplates")).toBe(true);  // enabled=true
    expect(isFeatureEffectivelyEnabled(member, orgA, "knowledgeBase")).toBe(false); // enabled=false
  });
  it("editor: always true (even when toggle is off)", () => {
    const orgWithEditor = {
      ...orgA,
      shareSettings: { ...orgA.shareSettings!, knowledgeBase: { enabled: false, editors: ["u-editor"] } },
    };
    expect(isFeatureEffectivelyEnabled(editor, orgWithEditor as any, "knowledgeBase")).toBe(true);
  });
  it("admin: always true (even when toggle is off)", () => {
    expect(isFeatureEffectivelyEnabled(admin, orgA, "knowledgeBase")).toBe(true);
  });
  it("always-on features: always true", () => {
    expect(isFeatureEffectivelyEnabled(member, orgA, "brandGuidelines")).toBe(true);
    expect(isFeatureEffectivelyEnabled(member, orgA, "marketingStrategy")).toBe(true);
  });
});

describe("canEditItem", () => {
  it("owner always edits", () => {
    expect(canEditItem(item, owner, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
  it("org admin always edits", () => {
    expect(canEditItem(item, admin, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
    expect(canEditItem(item, admin, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
  });
  it("toggleable feature: editor allowed regardless of enabled toggle", () => {
    expect(canEditItem(item, editor, orgA, ownerOrgId, "htmlTemplates")).toBe(true);
    // Editor still has rights when sharing is disabled — `enabled` only
    // controls visibility for plain members, not editor rights.
    const orgDisabled = { ...orgA, shareSettings: { ...orgA.shareSettings!, htmlTemplates: { enabled: false, editors: ["u-editor"] } } };
    expect(canEditItem(item, editor, orgDisabled, ownerOrgId, "htmlTemplates")).toBe(true);
  });
  it("always-on feature: editor allowed regardless of any enabled flag", () => {
    const bgEditor = { userId: "u-bg-editor", orgId: "org-A", orgRole: "member" as const };
    expect(canEditItem(item, bgEditor, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
    expect(canEditItem(item, bgEditor, orgA, ownerOrgId, "marketingStrategy")).toBe(false);
  });
  it("non-editor org member blocked", () => {
    expect(canEditItem(item, member, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
  });
  it("different-org user blocked", () => {
    expect(canEditItem(item, other, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
  });
});

describe("feature defaults (single source of truth)", () => {
  it("skills and workPlans default to enabled; others default to disabled", () => {
    expect(defaultEnabledFor("skills")).toBe(true);
    expect(defaultEnabledFor("workPlans")).toBe(true);
    expect(defaultEnabledFor("knowledgeBase")).toBe(false);
    expect(defaultEnabledFor("htmlTemplates")).toBe(false);
    expect(defaultEnabledFor("landingPages")).toBe(false);
    expect(defaultEnabledFor("analytics")).toBe(false);
  });

  it("always-on features report enabled by default", () => {
    expect(defaultEnabledFor("brandGuidelines")).toBe(true);
    expect(defaultEnabledFor("marketingStrategy")).toBe(true);
  });

  it("defaultShareSettings matches per-feature defaults with empty editors", () => {
    const s = defaultShareSettings();
    expect(s.skills).toEqual({ enabled: true, editors: [] });
    expect(s.workPlans).toEqual({ enabled: true, editors: [] });
    expect(s.knowledgeBase).toEqual({ enabled: false, editors: [] });
    expect(s.htmlTemplates).toEqual({ enabled: false, editors: [] });
    expect(s.landingPages).toEqual({ enabled: false, editors: [] });
    expect(s.analytics).toEqual({ enabled: false, editors: [] });
    expect(s.brandGuidelines).toEqual({ editors: [] });
    expect(s.marketingStrategy).toEqual({ editors: [] });
  });
});

describe("absent-config fallback (org never had shareSettings written)", () => {
  // Org created without shareSettings at all — the real-world bug case.
  const orgNoSettings = { orgId: "org-A", ownerUserId: "u-admin", name: "A" } as unknown as Organization;
  // Org with shareSettings present but missing the `skills` key entirely.
  const orgPartial = {
    orgId: "org-A", ownerUserId: "u-admin", name: "A",
    shareSettings: { knowledgeBase: { enabled: false, editors: [] } },
  } as unknown as Organization;

  it("plain member sees skills (default-on) when org has no shareSettings", () => {
    expect(isFeatureEffectivelyEnabled(member, orgNoSettings, "skills")).toBe(true);
    expect(canViewItem(item, member, orgNoSettings, ownerOrgId, "skills")).toBe(true);
  });

  it("plain member sees workPlans (default-on) when org has no shareSettings", () => {
    expect(isFeatureEffectivelyEnabled(member, orgNoSettings, "workPlans")).toBe(true);
  });

  it("plain member does NOT see default-off features when org has no shareSettings", () => {
    expect(isFeatureEffectivelyEnabled(member, orgNoSettings, "knowledgeBase")).toBe(false);
    expect(canViewItem(item, member, orgNoSettings, ownerOrgId, "landingPages")).toBe(false);
  });

  it("falls back to the skills default when shareSettings exists but omits skills", () => {
    expect(isFeatureEffectivelyEnabled(member, orgPartial, "skills")).toBe(true);
  });

  it("an explicit skills.enabled=false still overrides the default", () => {
    const orgOff = {
      orgId: "org-A", ownerUserId: "u-admin", name: "A",
      shareSettings: { skills: { enabled: false, editors: [] } },
    } as unknown as Organization;
    expect(isFeatureEffectivelyEnabled(member, orgOff, "skills")).toBe(false);
    expect(canViewItem(item, member, orgOff, ownerOrgId, "skills")).toBe(false);
  });
});

describe("isAlwaysOnFeature", () => {
  it("classifies BG and MS as always-on", () => {
    expect(isAlwaysOnFeature("brandGuidelines")).toBe(true);
    expect(isAlwaysOnFeature("marketingStrategy")).toBe(true);
  });
  it("classifies the five toggleable features", () => {
    (["knowledgeBase","htmlTemplates","landingPages","workPlans","skills"] as Feature[])
      .forEach(f => expect(isAlwaysOnFeature(f)).toBe(false));
  });
});

describe("listOrgVisibleItems", () => {
  it("returns only ownItems when feature is disabled", async () => {
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: false,
      getOwnerItems: async () => [{ id: "a", userId: "u-1" }],
      getMemberIds:  async () => ["u-1", "u-2"],
      getItemsForOwner: async () => [{ id: "x", userId: "u-2" }],
      getId: (i: any) => i.id,
    });
    expect(result.items.map((i: any) => i.id)).toEqual(["a"]);
    expect(result.truncated).toBe(false);
  });

  it("merges own + each other member's items when enabled", async () => {
    const ownItems    = [{ id: "a", userId: "u-1" }];
    const otherItems  = {
      "u-2": [{ id: "b", userId: "u-2" }, { id: "c", userId: "u-2" }],
      "u-3": [{ id: "d", userId: "u-3" }],
    };
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => ownItems,
      getMemberIds:  async () => ["u-1", "u-2", "u-3"],
      getItemsForOwner: async (uid: string) => (otherItems as any)[uid] || [],
      getId: (i: any) => i.id,
    });
    expect(result.items.map((i: any) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes by id (own item also present in org list)", async () => {
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => [{ id: "a", userId: "u-1" }],
      getMemberIds:  async () => ["u-1", "u-2"],
      getItemsForOwner: async () => [{ id: "a", userId: "u-1" }],
      getId: (i: any) => i.id,
    });
    expect(result.items).toHaveLength(1);
  });

  it("caps member fanout and flags truncated when over MEMBER_FANOUT_CAP", async () => {
    const many = Array.from({ length: MEMBER_FANOUT_CAP + 5 }, (_, i) => `u-${i}`);
    const result = await listOrgVisibleItems({
      callerUserId: "u-x",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => [],
      getMemberIds:  async () => many,
      getItemsForOwner: async () => [],
      getId: (i: any) => i.id,
    });
    expect(result.truncated).toBe(true);
  });
});
