/**
 * ENG-2840 (W2-8): a customer can never attach one of AgentWeb's own domains (or a host under one) as a custom domain. Every
 * customer project lives in AgentWeb's own Vercel team, so Vercel would report such a host as verified with no proof from the
 * customer. addCustomDomain refuses it before any Vercel call; managed subdomains (addSubdomain) are unaffected.
 */
const mockPut = jest.fn();
const mockQuery = jest.fn();
jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: (...a: unknown[]) => mockPut(...a),
        query: (...a: unknown[]) => mockQuery(...a),
        get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
        update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
        delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
        scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
      })),
    },
  },
}));

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosDelete = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => mockAxiosPost(...args),
    get: (...args: any[]) => mockAxiosGet(...args),
    delete: (...args: any[]) => mockAxiosDelete(...args),
  },
}));

const mockGetVercelToken = jest.fn();
jest.mock("../utils/secretsManager", () => ({
  getVercelToken: (...a: unknown[]) => mockGetVercelToken(...a),
}));

import {
  addCustomDomain,
  addSubdomain,
  isReservedPlatformDomain,
  RESERVED_PLATFORM_DOMAINS,
  SUBDOMAIN_BASE,
} from "../services/customDomainService";

const expectNoVercelCall = () => {
  expect(mockGetVercelToken).not.toHaveBeenCalled();
  expect(mockAxiosPost).not.toHaveBeenCalled();
  expect(mockAxiosGet).not.toHaveBeenCalled();
  expect(mockAxiosDelete).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetVercelToken.mockResolvedValue("test-vercel-token");
  mockPut.mockReturnValue({ promise: () => Promise.resolve() });
  mockQuery.mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
});

describe("RESERVED_PLATFORM_DOMAINS", () => {
  it("is exactly agentweb.pro, agentwebforms.com and hireemma.ai", () => {
    expect([...RESERVED_PLATFORM_DOMAINS].sort()).toEqual(["agentweb.pro", "agentwebforms.com", "hireemma.ai"]);
    expect(RESERVED_PLATFORM_DOMAINS).toContain(SUBDOMAIN_BASE);
  });

  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(RESERVED_PLATFORM_DOMAINS)).toBe(true);
  });
});

describe("isReservedPlatformDomain", () => {
  it.each(["agentweb.pro", "agentwebforms.com", "hireemma.ai"])("is true for the apex %s", (d) => {
    expect(isReservedPlatformDomain(d)).toBe(true);
  });

  it.each([
    "app.agentweb.pro",
    "a.b.c.agentweb.pro",
    "client.agentwebforms.com",
    "www.hireemma.ai",
    "deep.nested.hireemma.ai",
  ])("is true for the subdomain %s", (d) => {
    expect(isReservedPlatformDomain(d)).toBe(true);
  });

  it.each([
    "AgentWeb.PRO",
    "APP.AGENTWEBFORMS.COM",
    "  hireemma.ai  ",
    "\tWWW.HireEmma.AI\n",
    "agentweb.pro.",
    "app.agentwebforms.com..",
    "  App.HireEmma.ai.  ",
  ])("is true in any case, with surrounding spaces or trailing dots: %j", (d) => {
    expect(isReservedPlatformDomain(d)).toBe(true);
  });

  it.each([
    "notagentweb.pro",
    "agentweb.pro.evil.com",
    "agentwebforms.co",
    "myhireemma.ai",
    "agentweb.pro-evil.com",
    "evil-agentwebforms.com",
    "hireemma.ai.attacker.net",
    "agentweb.proxy",
    "example.com",
    "landing.example.com",
    "",
  ])("is false for the look-alike or unrelated host %j", (d) => {
    expect(isReservedPlatformDomain(d)).toBe(false);
  });

  it("does not throw on a non-string (null/undefined) and answers false", () => {
    expect(isReservedPlatformDomain(undefined as any)).toBe(false);
    expect(isReservedPlatformDomain(null as any)).toBe(false);
  });
});

describe("addCustomDomain refuses AgentWeb's own domains before any Vercel call", () => {
  it.each([
    "agentweb.pro",
    "app.agentweb.pro",
    "agentwebforms.com",
    "victim.agentwebforms.com",
    "hireemma.ai",
    "www.hireemma.ai",
    "AgentWeb.Pro",
    "  WWW.HIREEMMA.AI  ",
  ])("throws 'Invalid domain:' for %j", async (domain) => {
    const err = await addCustomDomain("user-1", "prj_1", domain).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("Invalid domain:")).toBe(true);
    expectNoVercelCall();
  });

  it("names the reserved host in the refusal (not the generic format error)", async () => {
    const err = await addCustomDomain("user-1", "prj_1", "Shop.AgentWeb.pro").catch((e) => e);
    expect(err.message).toMatch(/^Invalid domain: shop\.agentweb\.pro is an AgentWeb domain/);
    expectNoVercelCall();
  });

  it("a trailing-dot reserved host is still refused with 'Invalid domain:' and no Vercel call", async () => {
    const err = await addCustomDomain("user-1", "prj_1", "agentweb.pro.").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith("Invalid domain:")).toBe(true);
    expectNoVercelCall();
  });

  it.each(["notagentweb.pro", "agentweb.pro.evil.com", "agentwebforms.co", "myhireemma.ai"])(
    "a look-alike %s still goes to Vercel as a normal custom domain",
    async (domain) => {
      mockAxiosPost.mockResolvedValueOnce({ data: { name: domain, verified: false, verification: [] } });
      const rec = await addCustomDomain("user-1", "prj_1", domain);
      expect(rec).toMatchObject({ domain, type: "custom", status: "pending_verification" });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining("/v10/projects/prj_1/domains"),
        { name: domain },
        expect.any(Object)
      );
    }
  );

  it("works as before for a normal domain (pending, then saved)", async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        name: "landing.example.com",
        verified: false,
        verification: [{ type: "TXT", domain: "_vercel.landing.example.com", value: "vc-domain-verify=abc" }],
      },
    });

    const rec = await addCustomDomain("user-1", "prj_1", "Landing.Example.com");

    expect(rec).toMatchObject({
      userId: "user-1",
      domain: "landing.example.com",
      type: "custom",
      status: "pending_verification",
      vercelProjectId: "prj_1",
    });
    expect(rec.verificationRecords).toEqual([
      { type: "TXT", domain: "_vercel.landing.example.com", value: "vc-domain-verify=abc" },
    ]);
    expect(mockGetVercelToken).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({ Item: expect.objectContaining({ domain: "landing.example.com", type: "custom" }) })
    );
  });

  it("a normal domain verified with DNS pointed is active, as before", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { name: "landing.example.com", verified: true } });
    mockAxiosGet.mockResolvedValueOnce({ data: { misconfigured: false } });
    const rec = await addCustomDomain("user-1", "prj_1", "landing.example.com");
    expect(rec.status).toBe("active");
  });
});

describe("addSubdomain (managed *.agentwebforms.com) is unaffected", () => {
  it("still registers <label>.agentwebforms.com with Vercel", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { name: "mysite.agentwebforms.com" } });

    const rec = await addSubdomain("user-1", "prj_1", "mysite");

    expect(rec).toMatchObject({ domain: "mysite.agentwebforms.com", type: "subdomain", status: "active" });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining("vercel.com"),
      expect.objectContaining({ name: "mysite.agentwebforms.com" }),
      expect.any(Object)
    );
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({ Item: expect.objectContaining({ domain: "mysite.agentwebforms.com", type: "subdomain" }) })
    );
  });
});
