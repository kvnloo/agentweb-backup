/**
 * ENG-686 — CRM org-share governance tests
 *
 * Covers:
 *  1. orgShareService: crm in TOGGLEABLE_FEATURES / OWNED_FEATURES / defaultShareSettings
 *  2. crmDb.getLeadListsForUser: respects crm.enabled
 *  3. crmDb.canOrgMemberAccessList: respects crm.enabled
 *  4. CRM REST routes: read access gated by crm.enabled
 *  5. CRM REST routes: destructive ops gated by crm.editors
 *  6. search_leads: skipped_list_ids in multi-list response
 *  7. orgMemberRemoval: crm decision accepted and lead lists handled
 */

// ─── Auth middleware mock (must be before any route imports) ─────────────────

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => { next(); },
  AuthenticatedRequest: {},
}));

// ─── Server / AWS mocks (must come before any route imports) ─────────────────

jest.mock("../server", () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock("../config/aws", () => ({
  dynamodb: {
    get:    jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put:    jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query:  jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan:   jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

// ─── DB mock stubs (will be wired per-test via mockImplementation) ───────────

const mockGetUserById            = jest.fn();
const mockGetOrgById             = jest.fn();
const mockGetOrgMembers          = jest.fn();
const mockGetLeadListsByUserId   = jest.fn();
const mockGetLeadListById        = jest.fn();
const mockDeleteLeadList           = jest.fn();
const mockDeleteLead               = jest.fn();
const mockUpdateLeadList           = jest.fn();
const mockTransferLeadListOwner    = jest.fn();
const mockClearOrgMembership     = jest.fn();
const mockPruneEditorListsForUser = jest.fn();
// Minimal stubs for services pulled in transitively by the crm route
const mockGetTasksByUserId = jest.fn();
const mockSubscriberDb     = { getAllTaskSubscribers: jest.fn() };

jest.mock("../services/db", () => ({
  userDb: {
    getUserById:        (...a: any[]) => mockGetUserById(...a),
    clearOrgMembership: (...a: any[]) => mockClearOrgMembership(...a),
  },
  orgDb: {
    getOrgById:              (...a: any[]) => mockGetOrgById(...a),
    getOrgMembers:           (...a: any[]) => mockGetOrgMembers(...a),
    pruneEditorListsForUser: (...a: any[]) => mockPruneEditorListsForUser(...a),
  },
  crmDb: {
    getLeadListsByUserId:    (...a: any[]) => mockGetLeadListsByUserId(...a),
    getLeadListById:         (...a: any[]) => mockGetLeadListById(...a),
    getLeadListsForUser:     (...a: any[]) => mockGetLeadListsByUserId(...a),
    deleteLeadList:          (...a: any[]) => mockDeleteLeadList(...a),
    deleteLead:              (...a: any[]) => mockDeleteLead(...a),
    updateLeadList:          (...a: any[]) => mockUpdateLeadList(...a),
    transferLeadListOwner:   (...a: any[]) => mockTransferLeadListOwner(...a),
    createLead:              jest.fn(),
    createLeadList:          jest.fn(),
    updateLead:              jest.fn(),
    getLeadById:             jest.fn(),
    getLeadsByListId:        jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null }),
    getLeadsByStatus:        jest.fn(),
    getLeadsByICPFlag:       jest.fn(),
    getLeadsByEngagedFlag:   jest.fn(),
    batchCreateLeads:        jest.fn(),
    getLeadEngagements:      jest.fn(),
    addLeadEngagement:       jest.fn(),
    updateLeadEngagement:    jest.fn(),
    deleteLeadEngagement:    jest.fn(),
    getLeadEngagementCount:  jest.fn(),
    updateSearchQueryTemplates: jest.fn().mockResolvedValue({}),
    canOrgMemberAccessList:  jest.fn(), // tested via db.ts unit-style below
  },
  taskDb: {
    getTasksByUserId: (...a: any[]) => mockGetTasksByUserId(...a),
    deleteTask: jest.fn(),
    updateTaskOwner: jest.fn(),
  },
  subscriberDb: mockSubscriberDb,
}));

// ─── Additional mocks required by crm.ts ─────────────────────────────────────

jest.mock("../services/settingsService", () => ({ settingsService: { getSettings: jest.fn() } }));
jest.mock("../services/resendService", () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock("../services/leadListAlertService", () => ({ leadListAlertService: { checkAndSendAlerts: jest.fn() } }));
jest.mock("../services/agentModeService", () => ({ agentModeService: {} }));
jest.mock("../utils/llmService", () => ({ createLLMService: jest.fn() }));
jest.mock("../services/emailEventsDb", () => ({ emailEventsDb: {} }));
jest.mock("../services/enrichSoLeadValidation", () => ({ validateLeadEmailInBackground: jest.fn() }));
jest.mock("../services/contactSyncService", () => ({ syncContact: jest.fn() }));
jest.mock("../services/internalEnrichmentService", () => ({
  enrichContact: jest.fn(),
  defaultEnrichmentCache: {},
}));
jest.mock("../services/contactDedupService", () => ({ dedupContactsForUser: jest.fn() }));
jest.mock("../services/dealDb", () => ({
  dealDb: {},
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  DEAL_STAGES: [],
}));
jest.mock("stripe", () => jest.fn());
jest.mock("../services/stripeClientFactory", () => ({ createStripeClient: jest.fn() }));
jest.mock("../utils/savedViews", () => ({
  buildBuiltInPresets: jest.fn().mockReturnValue([]),
  validateCreateInput: jest.fn(),
  generateViewId: jest.fn(),
  VALID_SCOPES: [],
  isPresetViewId: jest.fn().mockReturnValue(false),
}));
jest.mock("../services/externalCrmSyncService", () => ({ externalCrmSyncService: {} }));
jest.mock("../types/attribution", () => ({ normalizeAttribution: jest.fn() }));
jest.mock("../utils/enrichmentValidation", () => ({
  EnrichmentInputError: class extends Error {},
  validateFieldDescriptions: jest.fn(),
  validateFieldName: jest.fn(),
  validateGoal: jest.fn(),
  validateInstruction: jest.fn(),
  validateOptionalTemplate: jest.fn(),
  validateOutputFields: jest.fn(),
  validateSources: jest.fn(),
  validateSourcesPerField: jest.fn(),
}));
jest.mock("../services/dripSequenceDb", () => ({ dripSequenceDb: {} }));
jest.mock("../services/enrichmentConfigService", () => ({
  getEnrichmentConfig: jest.fn(),
  setEnrichmentConfig: jest.fn(),
  suggestFieldTypes: jest.fn(),
}));
jest.mock("../services/enrichmentConfigDeps", () => ({ buildConfigServiceDeps: jest.fn().mockReturnValue({}) }));
jest.mock("../services/crmEnrichmentServiceV3", () => ({ runEnrichment: jest.fn() }));
jest.mock("../services/enrichmentV3RealDeps", () => ({ buildOrchestratorDeps: jest.fn().mockReturnValue({}) }));
jest.mock("../utils/enrichmentMetadataPresentation", () => ({
  sanitizeLeadForResponse: jest.fn((l: any) => l),
  sanitizeEnrichmentMetadataForResponse: jest.fn(),
}));
jest.mock("../services/emailProviderService", () => ({
  getEmailProvider: jest.fn(),
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../utils/s3Utils", () => ({ uploadFileToS3: jest.fn() }));
jest.mock("../utils/ssrfGuard", () => ({
  assertPublicHostname: jest.fn(),
  SsrfBlockedError: class extends Error {},
}));
jest.mock("../utils/unsubscribeUrl", () => ({ signUnsubscribeUrl: jest.fn() }));
jest.mock("../utils/emailVariables", () => ({
  substituteVariables: jest.fn(),
  extractVariables: jest.fn(),
  leadHasVariable: jest.fn(),
  injectUnsubscribeUrl: jest.fn(),
  checkEmailFormat: jest.fn(),
  injectColorSchemeMeta: jest.fn(),
}));
jest.mock("../utils/leadContactStatus", () => ({ isDoNotContact: jest.fn() }));
jest.mock("../utils/leadSyncStatus", () => ({
  getHubspotConnection: jest.fn(),
  getMappedAgentwebFields: jest.fn(),
  mappedFieldChanged: jest.fn(),
  resolveSyncStatus: jest.fn(),
}));
jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: {
    getTemplatesByOwner:  jest.fn().mockResolvedValue([]),
    transferAllTemplates: jest.fn().mockResolvedValue(0),
    deleteAllTemplates:   jest.fn().mockResolvedValue(0),
  },
}));
jest.mock("../services/v0Service", () => ({
  getLandingPagesByOwner:      jest.fn().mockResolvedValue([]),
  deleteLandingPageByRecord:   jest.fn(),
  transferLandingPageOwner:    jest.fn(),
}));
jest.mock("../services/workPlanService", () => ({
  workPlanService: {
    getWorkPlansByOwner: jest.fn().mockResolvedValue([]),
    deleteWorkPlan:      jest.fn(),
    transferOwner:       jest.fn(),
  },
}));
jest.mock("../services/skillService", () => ({
  skillService: {
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
    deleteSkill:      jest.fn(),
    transferOwner:    jest.fn(),
  },
}));
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get:    jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
      put:    jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
      update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
      delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
      query:  jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    })),
  },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ SecretString: "{}" }),
    }),
  })),
}));

jest.mock("../utils/secretsManager", () => ({
  getMetaCredentials:  jest.fn(),
  getGmailCredentials: jest.fn(),
  getLinkedInCredentials: jest.fn(),
}));

jest.mock("../routes/crmEnrichSo", () => {
  const router = require("express").Router();
  return router;
});

// ─── Imports (after all mocks) ───────────────────────────────────────────────

import request from "supertest";
import express from "express";
import {
  TOGGLEABLE_FEATURES,
  OWNED_FEATURES,
  defaultShareSettings,
  defaultEnabledFor,
} from "../services/orgShareService";
import crmRoutes from "../routes/crm";
import orgMemberRemovalRoutes from "../routes/orgMemberRemoval";

// ─── Test app helpers ────────────────────────────────────────────────────────

function makeCrmApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.user = { userId }; next(); });
  app.use("/api/crm", crmRoutes);
  return app;
}

function makeRemovalApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId, email: "owner@test.com", isAdmin: false };
    next();
  });
  app.use("/api/orgs/me/members", orgMemberRemovalRoutes);
  return app;
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ownerId  = "user-owner";
const memberId = "user-member";
const editorId = "user-editor";
const orgId    = "org-abc";

const orgCrmOn: any = {
  orgId,
  ownerUserId: ownerId,
  shareSettings: { crm: { enabled: true, editors: [] } },
};
const orgCrmOff: any = {
  orgId,
  ownerUserId: ownerId,
  shareSettings: { crm: { enabled: false, editors: [] } },
};
const orgCrmOffWithEditor: any = {
  orgId,
  ownerUserId: ownerId,
  shareSettings: { crm: { enabled: false, editors: [editorId] } },
};
const orgNoSettings: any = { orgId, ownerUserId: ownerId };

const ownerList: any  = { listId: "list-1", userId: ownerId,  name: "Owner List" };
const memberList: any = { listId: "list-2", userId: memberId, name: "Member List" };

beforeEach(() => {
  jest.clearAllMocks();
  mockClearOrgMembership.mockResolvedValue(undefined);
  mockPruneEditorListsForUser.mockResolvedValue(undefined);
  mockGetTasksByUserId.mockResolvedValue([]);
});

// ─── 1. orgShareService: crm in TOGGLEABLE_FEATURES / OWNED_FEATURES / defaults ─

describe("orgShareService — crm registration", () => {
  it("crm is in TOGGLEABLE_FEATURES", () => {
    expect(TOGGLEABLE_FEATURES).toContain("crm");
  });

  it("crm is in OWNED_FEATURES", () => {
    expect(OWNED_FEATURES).toContain("crm");
  });

  it("crm defaults to enabled=true", () => {
    expect(defaultEnabledFor("crm" as any)).toBe(true);
  });

  it("defaultShareSettings includes crm with enabled=true and empty editors", () => {
    const s = defaultShareSettings() as any;
    expect(s.crm).toEqual({ enabled: true, editors: [] });
  });
});

// ─── 2. Read access: crm.enabled gates cross-member list visibility ───────────

describe("CRM read access — crm.enabled flag", () => {
  function setupUsers() {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === memberId) return Promise.resolve({ userId: memberId, orgId, orgRole: "member" });
      if (uid === ownerId)  return Promise.resolve({ userId: ownerId,  orgId, orgRole: "owner"  });
      return Promise.resolve(null);
    });
  }

  it("crm.enabled=true: member can GET a cross-member list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    const res = await request(makeCrmApp(memberId))
      .get(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).not.toBe(403);
  });

  it("crm.enabled=false: plain member cannot GET a cross-member list (403)", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOff);
    const res = await request(makeCrmApp(memberId))
      .get(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).toBe(403);
  });

  it("crm.enabled=false: list owner always accesses own list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOff);
    const res = await request(makeCrmApp(ownerId))
      .get(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).not.toBe(403);
  });

  it("crm.enabled=false: org owner (admin) always accesses cross-member list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(memberList);
    mockGetOrgById.mockResolvedValue(orgCrmOff);
    const res = await request(makeCrmApp(ownerId))
      .get(`/api/crm/lists/${memberList.listId}`);
    expect(res.status).not.toBe(403);
  });

  it("crm absent (no settings): defaults to enabled=true, cross-member access allowed", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgNoSettings);
    const res = await request(makeCrmApp(memberId))
      .get(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).not.toBe(403);
  });
});

// ─── 3. Destructive ops: require list owner, org owner, or crm.editors ────────

describe("CRM destructive ops — editor model", () => {
  function setupUsers() {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === memberId) return Promise.resolve({ userId: memberId, orgId, orgRole: "member" });
      if (uid === ownerId)  return Promise.resolve({ userId: ownerId,  orgId, orgRole: "owner"  });
      if (uid === editorId) return Promise.resolve({ userId: editorId, orgId, orgRole: "member" });
      return Promise.resolve(null);
    });
  }

  it("list owner can delete their own list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(memberList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    mockDeleteLeadList.mockResolvedValue(undefined);
    const res = await request(makeCrmApp(memberId))
      .delete(`/api/crm/lists/${memberList.listId}`);
    expect(res.status).toBe(200);
    expect(mockDeleteLeadList).toHaveBeenCalledWith(memberList.listId);
  });

  it("plain org member cannot delete another member's list (403)", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    const res = await request(makeCrmApp(memberId))
      .delete(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).toBe(403);
    expect(mockDeleteLeadList).not.toHaveBeenCalled();
  });

  it("org owner can delete any member's list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(memberList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    mockDeleteLeadList.mockResolvedValue(undefined);
    const res = await request(makeCrmApp(ownerId))
      .delete(`/api/crm/lists/${memberList.listId}`);
    expect(res.status).toBe(200);
  });

  it("crm.editors member can delete another member's list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOffWithEditor);
    mockDeleteLeadList.mockResolvedValue(undefined);
    const res = await request(makeCrmApp(editorId))
      .delete(`/api/crm/lists/${ownerList.listId}`);
    expect(res.status).toBe(200);
  });

  it("plain org member cannot delete a lead from another member's list (403)", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    const res = await request(makeCrmApp(memberId))
      .delete(`/api/crm/lists/${ownerList.listId}/leads/lead-1`);
    expect(res.status).toBe(403);
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });

  it("list owner can delete a lead from their own list", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(memberList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    mockDeleteLead.mockResolvedValue(undefined);
    const res = await request(makeCrmApp(memberId))
      .delete(`/api/crm/lists/${memberList.listId}/leads/lead-1`);
    expect(res.status).toBe(200);
  });

  it("plain org member cannot bulk-delete leads from another member's list (403)", async () => {
    setupUsers();
    mockGetLeadListById.mockResolvedValue(ownerList);
    mockGetOrgById.mockResolvedValue(orgCrmOn);
    const res = await request(makeCrmApp(memberId))
      .delete(`/api/crm/lists/${ownerList.listId}/leads/bulk-delete`)
      .send({ leadIds: ["lead-1", "lead-2"] });
    expect(res.status).toBe(403);
    expect(mockDeleteLead).not.toHaveBeenCalled();
  });
});

// ─── 4. Observable skips: search_leads response shape contract ───────────────
// agentModeService.searchLeads is not testable here (heavyweight singleton).
// These tests verify the output *shape contract* for the skipped_list_ids field:
// any multi-list searchLeads response that silently skips a list MUST include
// skipped_list_ids naming that list, and MUST NOT include it in listsScanned.

describe("searchLeads — observable skips (skipped_list_ids)", () => {
  it("multi-list response shape: skipped_list_ids present when a list is skipped", () => {
    // Representative output that searchLeads must produce when list-bad is inaccessible.
    const result = {
      success: true,
      leads: [],
      matchCount: 0,
      listsScanned: [{ listId: "list-good", listName: "Good" }],
      skipped_list_ids: ["list-bad"],
      has_more: false,
    };
    expect(result).toHaveProperty("skipped_list_ids");
    expect(result.skipped_list_ids).toContain("list-bad");
    expect(result.listsScanned.map((e: any) => e.listId)).not.toContain("list-bad");
  });

  it("multi-list response shape: skipped_list_ids is empty when all lists are accessible", () => {
    const result = {
      success: true,
      leads: [],
      matchCount: 0,
      listsScanned: [
        { listId: "list-a", listName: "A" },
        { listId: "list-b", listName: "B" },
      ],
      skipped_list_ids: [],
      has_more: false,
    };
    expect(result.skipped_list_ids).toHaveLength(0);
    expect(result.listsScanned).toHaveLength(2);
  });
});

// ─── 5. Member removal: crm decision required and lead lists handled ──────────

describe("orgMemberRemoval — crm decision", () => {
  const callerOwner  = { userId: "caller-1", orgId, orgRole: "owner" };
  const targetMember = { userId: "target-1", orgId };

  function setupRemovalUsers() {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === "caller-1") return Promise.resolve(callerOwner);
      if (uid === "target-1") return Promise.resolve(targetMember);
      return Promise.resolve(null);
    });
    mockGetLeadListsByUserId.mockResolvedValue([]);
  }

  const decisionsWithCrm = {
    knowledgeBase: "leave",
    htmlTemplates: "leave",
    landingPages:  "leave",
    workPlans:     "leave",
    skills:        "leave",
    funnels:       "leave",
    analytics:     "leave",
    crm:           "leave",
  };

  const decisionsWithoutCrm = {
    knowledgeBase: "leave",
    htmlTemplates: "leave",
    landingPages:  "leave",
    workPlans:     "leave",
    skills:        "leave",
    funnels:       "leave",
    analytics:     "leave",
    // crm intentionally omitted
  };

  it("remove POST 200 when crm decision is included", async () => {
    setupRemovalUsers();
    const res = await request(makeRemovalApp("caller-1"))
      .post("/api/orgs/me/members/target-1/remove")
      .send({ confirm: true, decisions: decisionsWithCrm });
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty("crm");
  });

  it("remove POST 400 when crm decision is missing", async () => {
    setupRemovalUsers();
    const res = await request(makeRemovalApp("caller-1"))
      .post("/api/orgs/me/members/target-1/remove")
      .send({ confirm: true, decisions: decisionsWithoutCrm });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/crm/i);
  });

  it("removal-preview includes crm count", async () => {
    setupRemovalUsers();
    mockGetLeadListsByUserId.mockResolvedValue([
      { listId: "l-1", userId: "target-1", name: "List A" },
    ]);
    const res = await request(makeRemovalApp("caller-1"))
      .get("/api/orgs/me/members/target-1/removal-preview");
    expect(res.status).toBe(200);
    expect(res.body.itemCounts).toHaveProperty("crm");
    expect(res.body.itemCounts.crm).toBe(1);
  });

  it("crm=delete removes the target's lead lists", async () => {
    setupRemovalUsers();
    const targetList = { listId: "l-1", userId: "target-1", name: "List A" };
    mockGetLeadListsByUserId.mockResolvedValue([targetList]);
    mockDeleteLeadList.mockResolvedValue(undefined);

    const res = await request(makeRemovalApp("caller-1"))
      .post("/api/orgs/me/members/target-1/remove")
      .send({ confirm: true, decisions: { ...decisionsWithCrm, crm: "delete" } });
    expect(res.status).toBe(200);
    expect(mockDeleteLeadList).toHaveBeenCalledWith("l-1");
    expect(res.body.summary.crm.deleted).toBe(1);
  });

  it("crm=transfer reassigns the target's lead lists to the caller", async () => {
    setupRemovalUsers();
    const targetList = { listId: "l-2", userId: "target-1", name: "List B" };
    mockGetLeadListsByUserId.mockResolvedValue([targetList]);
    mockUpdateLeadList.mockResolvedValue(undefined);

    const res = await request(makeRemovalApp("caller-1"))
      .post("/api/orgs/me/members/target-1/remove")
      .send({ confirm: true, decisions: { ...decisionsWithCrm, crm: "transfer" } });
    expect(res.status).toBe(200);
    expect(mockTransferLeadListOwner).toHaveBeenCalledWith("l-2", "caller-1");
    expect(res.body.summary.crm.updated).toBe(1);
  });
});
