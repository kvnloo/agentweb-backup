import request from "supertest";
import express from "express";
import orgShareRoutes from "../routes/orgShareSettings";

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn(), updateShareSettings: jest.fn() },
}));

import { userDb, orgDb } from "../services/db";
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

const app = express();
app.use(express.json());
// Inject req.user from x-uid header, simulating authenticateToken
app.use((req: any, _res: any, next: any) => {
  if (req.headers["x-uid"]) req.user = { userId: req.headers["x-uid"] };
  next();
});
app.use("/api/org-share-settings", orgShareRoutes);

const FULL = {
  knowledgeBase: { enabled: false, editors: [] },
  htmlTemplates: { enabled: false, editors: [] },
  landingPages: { enabled: false, editors: [] },
  workPlans: { enabled: false, editors: [] },
  skills: { enabled: false, editors: [] },
  analytics: { enabled: true, editors: [] },
  brandGuidelines: { editors: [] },
  marketingStrategy: { editors: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1", orgId: "org-1", orgRole: "owner" } as any);
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareSettings: FULL } as any);
  mockOrgDb.getOrgMembers.mockResolvedValue([{ userId: "owner-1" }, { userId: "m-1" }] as any);
});

test("owner can save settings including analytics", async () => {
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1").send({ shareSettings: { ...FULL, analytics: { enabled: true, editors: ["m-1"] } } });
  expect(res.status).toBe(200);
  expect(mockOrgDb.updateShareSettings).toHaveBeenCalled();
});

test("body omitting analytics is back-filled from existing org settings (old client)", async () => {
  const { analytics, ...withoutAnalytics } = FULL;
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1").send({ shareSettings: withoutAnalytics });
  expect(res.status).toBe(200);
  const saved = mockOrgDb.updateShareSettings.mock.calls[0][1];
  expect(saved.analytics).toEqual({ enabled: true, editors: [] });
});

test("non-owner editor cannot change settings → 403", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "m-1", orgId: "org-1", orgRole: "member" } as any);
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "m-1").send({ shareSettings: FULL });
  expect(res.status).toBe(403);
});

test("analytics editor not in org → 400", async () => {
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1")
    .send({ shareSettings: { ...FULL, analytics: { enabled: true, editors: ["stranger"] } } });
  expect(res.status).toBe(400);
});
