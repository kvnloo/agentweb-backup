import request from "supertest";
import express from "express";
import sequenceRoutes from "../routes/sequences";
import { dripSequenceDb } from "../services/dripSequenceDb";

jest.mock("../services/dripSequenceDb", () => ({
  dripSequenceDb: {
    listSequences: jest.fn(),
    getSequence: jest.fn(),
    listEnrollmentsForSequence: jest.fn(),
    getEnrollmentStats: jest.fn(),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "tenant-1" };
    next();
  },
}));

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;

const app = express();
app.use(express.json());
app.use("/api/crm/sequences", sequenceRoutes);

const SEQ_ACTIVE = {
  sequenceId: "seq-active",
  userId: "tenant-1",
  name: "Trial nurture",
  status: "active",
  steps: [{ stepId: "a" }, { stepId: "b" }],
  autoEnrollListIds: ["list-1"],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

describe("ENG-962 read-only sequence endpoints (list_crm_sequences backing)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists only the caller's sequences", async () => {
    mockDb.listSequences.mockResolvedValue([SEQ_ACTIVE] as any);
    const res = await request(app).get("/api/crm/sequences").expect(200);
    expect(mockDb.listSequences).toHaveBeenCalledWith("tenant-1");
    expect(res.body.sequences).toHaveLength(1);
    expect(res.body.sequences[0].sequenceId).toBe("seq-active");
  });

  it("never returns another user's sequence on inspect (403)", async () => {
    mockDb.getSequence.mockResolvedValue({ ...SEQ_ACTIVE, userId: "tenant-2" } as any);
    await request(app).get("/api/crm/sequences/seq-active").expect(403);
  });

  it("reports enrollment stats for an owned sequence", async () => {
    mockDb.getSequence.mockResolvedValue(SEQ_ACTIVE as any);
    mockDb.listEnrollmentsForSequence.mockResolvedValue([] as any);
    mockDb.getEnrollmentStats.mockResolvedValue({ total: 3 } as any);
    const res = await request(app).get("/api/crm/sequences/seq-active/enrollments").expect(200);
    expect(res.body.stats).toMatchObject({ total: 3 });
  });
});
