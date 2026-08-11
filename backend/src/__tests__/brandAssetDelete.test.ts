/**
 * DELETE /api/brand/guidelines/asset/:key — the S3 object being deleted must
 * belong to the caller's own (or their org's) brand guidelines.
 *
 * The `key` path param and the `?url=` legacy fallback arrive straight from the
 * request and were passed to `s3.deleteObject` without ever being resolved
 * against `brandGuidelines.attachments`, so any authenticated user with brand
 * guidelines could delete ANY object in the bucket — verified live on the
 * ENG-927 preview: an unrelated user in a different org deleted another user's
 * logo and got "Asset deleted successfully", leaving the victim's record
 * pointing at a destroyed object.
 */

import express from "express";
import request from "supertest";

// ── Mock aws-sdk (brand.ts constructs DocumentClient + S3 at module load) ─────
const mockDynamoGet = jest.fn();
const mockDynamoUpdate = jest.fn();
const mockS3Delete = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      get: jest.fn((params: any) => ({ promise: () => mockDynamoGet(params) })),
      update: jest.fn((params: any) => ({ promise: () => mockDynamoUpdate(params) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    putObject: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    deleteObject: jest.fn((params: any) => ({ promise: () => mockS3Delete(params) })),
  })),
}));

const mockGetOrgById = jest.fn();
const mockGetUserById = jest.fn();
const mockGetUserByEmailConsistent = jest.fn();
const mockUpdateOrg = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    getUserByEmailConsistent: (...a: any[]) => mockGetUserByEmailConsistent(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    updateOrg: (...a: any[]) => mockUpdateOrg(...a),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
  AuthenticatedRequest: {},
}));

jest.mock("../services/brandBuildStatusService", () => ({
  buildReadyPatch: jest.fn().mockReturnValue(null),
  logCompletionMetric: jest.fn(),
}));

import brandRouter from "../routes/brand";

const BUCKET = process.env.AWS_S3_BUCKET || "agentweb-user-files";
const url = (key: string) => `https://${BUCKET}.s3.us-west-2.amazonaws.com/${key}`;

const OWN_LOGO_KEY = "users/me/brand/logo/logo.png";
const OWN_ASSET_KEY = "users/me/brand/assets/deck.png";
const VICTIM_KEY = "users/someone-else/brand/logo/their-logo.png";

const ownBrand = {
  brandData: { brandName: "Acme" },
  attachments: [
    { type: "logo", key: OWN_LOGO_KEY, url: url(OWN_LOGO_KEY), filename: "logo.png" },
    { type: "asset", key: OWN_ASSET_KEY, url: url(OWN_ASSET_KEY), filename: "deck.png" },
  ],
};

const soloUser = { userId: "me", email: "me@test.com", brandGuidelines: ownBrand };

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use("/api/brand", brandRouter);
  return app;
}

const del = (user: any, key: string, query = "") =>
  request(makeApp(user)).delete(
    `/api/brand/guidelines/asset/${encodeURIComponent(key)}${query}`
  );

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockDynamoUpdate.mockResolvedValue({ Attributes: {} });
  mockS3Delete.mockResolvedValue({});
  mockUpdateOrg.mockResolvedValue({});
  mockUpdateUser.mockResolvedValue({});
  // Undefined by default so the existing fixtures fall back to the GSI row.
  mockGetUserByEmailConsistent.mockResolvedValue(undefined);
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe("DELETE /api/brand/guidelines/asset/:key — ownership", () => {
  it("refuses a key that is not one of the caller's own attachments", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });

    const res = await del(soloUser, VICTIM_KEY);

    expect(res.status).toBe(404);
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockDynamoUpdate).not.toHaveBeenCalled();
  });

  it("refuses a ?url= fallback that points at someone else's object", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });

    const res = await del(soloUser, "undefined", `?url=${encodeURIComponent(url(VICTIM_KEY))}`);

    expect(res.status).toBe(404);
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockDynamoUpdate).not.toHaveBeenCalled();
  });

  it("refuses a request that identifies no asset at all", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });

    const res = await del(soloUser, "undefined");

    expect(res.status).toBe(404);
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockDynamoUpdate).not.toHaveBeenCalled();
  });

  it("still 404s when the caller has no brand guidelines at all", async () => {
    mockDynamoGet.mockResolvedValue({ Item: { userId: "me", email: "me@test.com" } });

    const res = await del(soloUser, OWN_LOGO_KEY);

    expect(res.status).toBe(404);
    expect(mockS3Delete).not.toHaveBeenCalled();
  });

  it("deletes an asset the caller does own, keeping the others", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });

    const res = await del(soloUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockS3Delete).toHaveBeenCalledWith(
      expect.objectContaining({ Key: OWN_ASSET_KEY })
    );
    const updated = mockDynamoUpdate.mock.calls[0][0];
    const attachments =
      updated.ExpressionAttributeValues[":brandGuidelines"].attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].key).toBe(OWN_LOGO_KEY);
  });

  it("deletes a legacy keyless attachment matched by url, deriving the S3 key", async () => {
    const legacyKey = "users/me/brand/assets/legacy.png";
    mockDynamoGet.mockResolvedValue({
      Item: {
        ...soloUser,
        brandGuidelines: {
          ...ownBrand,
          attachments: [{ type: "asset", url: url(legacyKey), filename: "legacy.png" }],
        },
      },
    });

    const res = await del(soloUser, "undefined", `?url=${encodeURIComponent(url(legacyKey))}`);

    expect(res.status).toBe(200);
    expect(mockS3Delete).toHaveBeenCalledWith(expect.objectContaining({ Key: legacyKey }));
  });

  it("resolves against the org owner's attachments on an un-copied org (ENG-927)", async () => {
    const orgUser = { userId: "me", email: "me@test.com", orgId: "org-1", orgRole: "owner" };
    mockDynamoGet.mockResolvedValue({ Item: { ...orgUser, brandGuidelines: ownBrand } });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "me",
      shareSettings: { brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] } },
    });

    const res = await del(orgUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockS3Delete).toHaveBeenCalledWith(
      expect.objectContaining({ Key: OWN_ASSET_KEY })
    );
    // The pruned list is written to the record that holds it — the owner's —
    // not promoted onto the org.
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({
        brandGuidelines: expect.objectContaining({
          attachments: [expect.objectContaining({ key: OWN_LOGO_KEY })],
        }),
      }),
      expect.anything()
    );
  });

  it("does NOT promote the owner's brand onto the org when deleting an asset", async () => {
    // Writing the pruned copy to the org would populate a record that was
    // deliberately empty: reads would stop falling back, so the owner's later
    // brandData edits would silently stop reaching the org. Deleting one asset
    // must not fork the brand.
    const orgUser = { userId: "me", email: "me@test.com", orgId: "org-1", orgRole: "owner" };
    mockDynamoGet.mockResolvedValue({ Item: { ...orgUser, brandGuidelines: ownBrand } });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "me",
      shareSettings: { brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] } },
    });

    const res = await del(orgUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it("prunes the OWNER's source record too, so no dangling reference survives", async () => {
    // The attachments came from the owner's user record (un-copied org) but the
    // pruned list is written to the ORG. Leaving the source untouched keeps a
    // pointer to an S3 object we just destroyed — and it resurfaces the moment
    // the org is deleted, which clears orgId and sends reads back to the user
    // record.
    const orgUser = { userId: "me", email: "me@test.com", orgId: "org-1", orgRole: "owner" };
    mockDynamoGet.mockResolvedValue({ Item: { ...orgUser, brandGuidelines: ownBrand } });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "me",
      shareSettings: { brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] } },
    });

    const res = await del(orgUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({
        brandGuidelines: expect.objectContaining({
          attachments: [expect.objectContaining({ key: OWN_LOGO_KEY })],
        }),
      }),
      expect.anything()
    );
  });

  it("prunes a non-caller owner's source record when a member editor deletes", async () => {
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: ownBrand,
    });

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "owner-u",
      expect.objectContaining({
        brandGuidelines: expect.objectContaining({
          attachments: [expect.objectContaining({ key: OWN_LOGO_KEY })],
        }),
      }),
      expect.anything()
    );
  });

  it("leaves the owner's record alone when the ORG record was the source", async () => {
    const orgUser = { userId: "me", email: "me@test.com", orgId: "org-1", orgRole: "owner" };
    mockDynamoGet.mockResolvedValue({ Item: { ...orgUser, brandGuidelines: ownBrand } });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "me",
      brandGuidelines: ownBrand,
      shareSettings: { brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] } },
    });

    const res = await del(orgUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("aborts without destroying anything when the owner's source prune fails", async () => {
    // Greptile P1: this used to be caught and warned. The S3 object was already
    // gone by then, so the endpoint reported success and left the owner pointing
    // at a destroyed object. The record write now happens first and uncaught, so
    // the only likely failure is a clean, fully retryable abort.
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: ownBrand,
    });
    mockUpdateUser.mockRejectedValue(new Error("ProvisionedThroughputExceeded"));

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(500);
    // Nothing destroyed: the object still exists and the org still resolves to
    // the owner's untouched list, so a retry sees exactly the pre-request state.
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });

  it("orders the record write before the S3 delete, so no record outlives its object", async () => {
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: ownBrand,
    });

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    // Exactly one record write, and it lands before the object is destroyed.
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateOrg).not.toHaveBeenCalled();
    const [ownerPrune] = mockUpdateUser.mock.invocationCallOrder;
    const [s3Delete] = mockS3Delete.mock.invocationCallOrder;
    expect(ownerPrune).toBeLessThan(s3Delete);
  });

  it("rolls the prune back and fails retryably when the object will not delete", async () => {
    // Dereferencing the attachment and leaving the bytes was the worst of both:
    // the object stays live at a URL that resolves, and the retry 404s because
    // the attachment it matches on is gone — so nothing can ever clean it up.
    mockDynamoGet.mockResolvedValue({ Item: soloUser });
    mockS3Delete.mockRejectedValue(new Error("AccessDenied"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await del(soloUser, OWN_ASSET_KEY);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/nothing was changed/i);
    // Last write restores the full attachment list, so a retry still resolves it.
    const restored =
      mockDynamoUpdate.mock.calls.at(-1)![0].ExpressionAttributeValues[":brandGuidelines"];
    expect(restored.attachments).toHaveLength(2);
    (console.error as jest.Mock).mockRestore();
  });

  it("retries a transient S3 failure instead of rolling back", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });
    mockS3Delete
      .mockRejectedValueOnce(new Error("SlowDown"))
      .mockResolvedValueOnce({});

    const res = await del(soloUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockS3Delete).toHaveBeenCalledTimes(2);
    // One write only — the prune stands, nothing was rolled back.
    expect(mockDynamoUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports the orphan when the rollback itself also fails", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });
    mockS3Delete.mockRejectedValue(new Error("AccessDenied"));
    mockDynamoUpdate
      .mockResolvedValueOnce({ Attributes: {} })
      .mockRejectedValueOnce(new Error("throughput exceeded"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await del(soloUser, OWN_ASSET_KEY);

    expect(res.status).toBe(500);
    expect(res.body.objectDeleted).toBe(false);
    (console.error as jest.Mock).mockRestore();
  });

  it("reports a clean delete when the object really is gone", async () => {
    mockDynamoGet.mockResolvedValue({ Item: soloUser });

    const res = await del(soloUser, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(res.body.objectDeleted).toBe(true);
  });

  it("prunes from the strong-consistent owner read, not the stale GSI row", async () => {
    // getUserById goes through UserIdIndex, which can return a row from before
    // a just-landed brand edit. Writing back that snapshot would roll the edit
    // back, since this path replaces the whole brandGuidelines value.
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: { ...ownBrand, brandData: { brandName: "Stale Co" } },
    });
    mockGetUserByEmailConsistent.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: { ...ownBrand, brandData: { brandName: "Renamed Co" } },
    });

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    expect(mockGetUserByEmailConsistent).toHaveBeenCalledWith("owner@test.com");
    // The rename survives the delete rather than being reverted to "Stale Co".
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "owner-u",
      expect.objectContaining({
        brandGuidelines: expect.objectContaining({
          brandData: { brandName: "Renamed Co" },
          attachments: [expect.objectContaining({ key: OWN_LOGO_KEY })],
        }),
      }),
      expect.anything()
    );
  });

  it("409s instead of clobbering when the owner's brand moves mid-delete", async () => {
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: { ...ownBrand, updatedAt: "2026-08-10T00:00:00.000Z" },
    });
    mockUpdateUser.mockRejectedValue(
      Object.assign(new Error("The conditional request failed"), {
        code: "ConditionalCheckFailedException",
      })
    );

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(409);
    // Aborted before the destructive step, so the retry has something to delete.
    expect(mockS3Delete).not.toHaveBeenCalled();
  });

  it("guards the owner write on the brand not having moved since it was read", async () => {
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: { ...ownBrand, updatedAt: "2026-08-10T00:00:00.000Z" },
    });

    await del(editor, OWN_ASSET_KEY);

    expect(mockUpdateUser).toHaveBeenCalledWith(
      "owner-u",
      expect.anything(),
      expect.objectContaining({
        condition: expect.objectContaining({
          expression: "brandGuidelines.updatedAt = :expectedBrandUpdatedAt",
          values: { ":expectedBrandUpdatedAt": "2026-08-10T00:00:00.000Z" },
        }),
      })
    );
  });

  it("advances the CAS token even when the write lands in the same millisecond", async () => {
    // The guard is only real if the token moves. updatedAt is millisecond
    // granular, so a write in the same millisecond as the value it read would
    // leave it identical — and the next concurrent delete would then pass its
    // condition against a stale attachment list, restoring a reference whose
    // S3 object is already gone.
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    const sameMs = new Date().toISOString();
    jest.spyOn(Date, "now").mockReturnValue(new Date(sameMs).getTime());
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    mockGetUserById.mockResolvedValue({
      userId: "owner-u",
      email: "owner@test.com",
      brandGuidelines: { ...ownBrand, updatedAt: sameMs },
    });

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(200);
    const written = mockUpdateUser.mock.calls[0][1].brandGuidelines.updatedAt;
    expect(written).not.toBe(sameMs);
    expect(new Date(written).getTime()).toBeGreaterThan(new Date(sameMs).getTime());
    (Date.now as jest.Mock).mockRestore();
  });

  it("aborts cleanly, not with a 500, when the owner row vanishes before the write", async () => {
    // The resolver already read this owner's brand to answer the request, so a
    // miss on the delete path's own lookup is GSI lag, not a real absence.
    // Spreading the undefined record threw a TypeError that surfaced as a
    // blanket 500 — after which nothing at all had been deleted.
    const editor = { userId: "editor-u", email: "editor@test.com", orgId: "org-1", orgRole: "member" };
    mockDynamoGet.mockResolvedValue({ Item: editor });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "owner-u",
      brandGuidelines: undefined,
      shareSettings: {
        brandGuidelines: { editors: ["editor-u"] },
        marketingStrategy: { editors: [] },
      },
    });
    // First lookup (via the resolver) sees the owner; the delete path's own
    // lookup then comes back empty.
    mockGetUserById
      .mockResolvedValueOnce({ userId: "owner-u", email: "owner@test.com", brandGuidelines: ownBrand })
      .mockResolvedValueOnce(undefined);
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await del(editor, OWN_ASSET_KEY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/try again/i);
    // Nothing destroyed, so the retry has something to delete.
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
    (console.error as jest.Mock).mockRestore();
  });

  it("refuses a foreign key even on an un-copied org", async () => {
    const orgUser = { userId: "me", email: "me@test.com", orgId: "org-1", orgRole: "owner" };
    mockDynamoGet.mockResolvedValue({ Item: { ...orgUser, brandGuidelines: ownBrand } });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-1",
      ownerUserId: "me",
      shareSettings: { brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] } },
    });

    const res = await del(orgUser, VICTIM_KEY);

    expect(res.status).toBe(404);
    expect(mockS3Delete).not.toHaveBeenCalled();
    expect(mockUpdateOrg).not.toHaveBeenCalled();
  });
});
