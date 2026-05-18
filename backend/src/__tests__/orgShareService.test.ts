import {
  canViewItem, canEditItem, isAlwaysOnFeature,
  Feature,
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
});

describe("canEditItem", () => {
  it("owner always edits", () => {
    expect(canEditItem(item, owner, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
  it("org admin always edits", () => {
    expect(canEditItem(item, admin, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
    expect(canEditItem(item, admin, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
  });
  it("toggleable feature: editor allowed only when enabled", () => {
    expect(canEditItem(item, editor, orgA, ownerOrgId, "htmlTemplates")).toBe(true);
    const orgDisabled = { ...orgA, shareSettings: { ...orgA.shareSettings!, htmlTemplates: { enabled: false, editors: ["u-editor"] } } };
    expect(canEditItem(item, editor, orgDisabled, ownerOrgId, "htmlTemplates")).toBe(false);
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
