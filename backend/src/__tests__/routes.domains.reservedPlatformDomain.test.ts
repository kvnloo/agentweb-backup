/**
 * ENG-2840 (W2-8): POST /api/domains/custom answers 400 for one of AgentWeb's own domains, through the REAL customDomainService
 * (only DynamoDB, Vercel/axios and the token are mocked), and nothing reaches Vercel. A normal domain still attaches (201).
 */
const mockQuery = jest.fn();
const mockPut = jest.fn();
jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        query: (...a: unknown[]) => mockQuery(...a),
        put: (...a: unknown[]) => mockPut(...a),
        get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
        update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
        delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
        scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
      })),
    },
    config: { update: jest.fn() },
  },
}));

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...a: any[]) => mockAxiosPost(...a),
    get: (...a: any[]) => mockAxiosGet(...a),
    delete: jest.fn(),
  },
}));

const mockGetVercelToken = jest.fn();
jest.mock("../utils/secretsManager", () => ({
  getVercelToken: (...a: unknown[]) => mockGetVercelToken(...a),
}));

jest.mock("../services/v0Service", () => ({
  updateSubdomainMiddleware: jest.fn(),
  canUserEditLandingPage: jest.fn(),
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgMembers: jest.fn() },
}));
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "user-1" };
    next();
  },
  AuthenticatedRequest: {},
}));

import express from "express";
import request from "supertest";
import domainRoutes from "../routes/domains";

const app = express();
app.use(express.json());
app.use("/api/domains", domainRoutes);

/** Every DynamoDB query answers "the caller owns a landing page on proj-1" (ownership check) / no domain rows (listDomains). */
const ownsProject = () =>
  mockQuery.mockImplementation((params: any) => ({
    promise: () =>
      Promise.resolve({
        Items: String(params?.TableName ?? "").includes("AW-LandingPages")
          ? [{ id: "page-1", userId: "user-1", vercelProjectId: "proj-1" }]
          : [],
      }),
  }));

beforeEach(() => {
  jest.resetAllMocks();
  ownsProject();
  mockPut.mockReturnValue({ promise: () => Promise.resolve() });
  mockGetVercelToken.mockResolvedValue("vercel-token");
});

describe("POST /api/domains/custom: AgentWeb's own domains", () => {
  it.each([
    "agentweb.pro",
    "app.agentweb.pro",
    "agentwebforms.com",
    "someone-else.agentwebforms.com",
    "hireemma.ai",
    "www.hireemma.ai",
    "API.AgentWeb.Pro",
  ])("answers 400 for %s and never calls Vercel", async (domain) => {
    const res = await request(app).post("/api/domains/custom").send({ vercelProjectId: "proj-1", domain });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/^Invalid domain:/);
    expect(mockGetVercelToken).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("still attaches a normal domain (201, sent to Vercel)", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { name: "landing.example.com", verified: false, verification: [] } });

    const res = await request(app)
      .post("/api/domains/custom")
      .send({ vercelProjectId: "proj-1", domain: "landing.example.com" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ domain: "landing.example.com", type: "custom", status: "pending_verification" });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining("/v10/projects/proj-1/domains"),
      { name: "landing.example.com" },
      expect.any(Object)
    );
  });

  it("a look-alike (notagentweb.pro) is a normal domain, not refused", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { name: "notagentweb.pro", verified: false, verification: [] } });
    const res = await request(app).post("/api/domains/custom").send({ vercelProjectId: "proj-1", domain: "notagentweb.pro" });
    expect(res.status).toBe(201);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });
});
