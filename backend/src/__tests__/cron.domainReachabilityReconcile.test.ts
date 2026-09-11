/**
 * ENG-1839 follow-up (2026-09-11) — a page's `customDomainUrl` is supposed to always have a
 * matching `AW-CustomDomains` record; that's the only reason `selectDomainsToProbe` can find it
 * at all. The invariant held only while every write to `customDomainUrl` went through
 * `addCustomDomain`/`addSubdomain`.
 *
 * It broke in production: a standing DynamoDB grant issued for an unrelated repair was reused to
 * repoint a live customer's domain via a direct table write. The page kept reading `deployed`,
 * no domain record was ever created, and the domain went completely unmonitored — with no log,
 * no error, nothing. `reconcileUnregisteredDomains` is the self-healing fix: find any deployed
 * page whose domain host has no matching record, and register it for real.
 */

const mockAddCustomDomain = jest.fn();
jest.mock("../services/customDomainService", () => ({
  addCustomDomain: (...a: unknown[]) => mockAddCustomDomain(...a),
  SUBDOMAIN_BASE: "agentwebforms.com",
}));

const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: (...a: unknown[]) => mockPut(...a),
      })),
    },
  },
}));

import { reconcileUnregisteredDomains } from "../cron/domainReachabilityCron";

class ConditionalCheckFailedException extends Error {
  code = "ConditionalCheckFailedException";
}

const page = (over: Record<string, any> = {}) => ({
  id: "page-1",
  userId: "user-1",
  vercelProjectId: "proj-1",
  status: "deployed",
  customDomainUrl: "https://campaign.acme.com",
  ...over,
});

describe("reconcileUnregisteredDomains", () => {
  beforeEach(() => {
    mockAddCustomDomain.mockReset();
    mockAddCustomDomain.mockResolvedValue({ id: "new-dom", domain: "campaign.acme.com" });
    mockPut.mockReset();
    mockPut.mockReturnValue({ promise: () => Promise.resolve({}) });
  });

  it("registers a deployed page's domain that has no matching record", async () => {
    const result = await reconcileUnregisteredDomains([], [page()]);

    expect(mockAddCustomDomain).toHaveBeenCalledWith("user-1", "proj-1", "campaign.acme.com");
    expect(result.reconciled).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.created).toEqual([{ id: "new-dom", domain: "campaign.acme.com" }]);
  });

  it("does nothing when a matching record already exists — the normal case", async () => {
    const domains = [{ id: "d1", domain: "campaign.acme.com" }];
    const result = await reconcileUnregisteredDomains(domains, [page()]);

    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(0);
  });

  it("skips a page that is not deployed — that failure would be expected, same as the sweep's own scope rule", async () => {
    const result = await reconcileUnregisteredDomains([], [page({ status: "generating" })]);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(0);
  });

  it("skips a page with no customDomainUrl — nothing to register", async () => {
    const result = await reconcileUnregisteredDomains([], [page({ customDomainUrl: undefined })]);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
  });

  it("tolerates an unparseable customDomainUrl without throwing", async () => {
    const result = await reconcileUnregisteredDomains([], [page({ customDomainUrl: "not a url" })]);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  it("never registers a managed agentwebforms.com subdomain — that gap is a different bug", async () => {
    // Managed subdomains are created atomically by addSubdomain as part of page creation. An
    // unregistered one means THAT path failed, not that this reconciliation should paper over
    // it with the wrong registration function (this would write type: "custom", not "subdomain").
    const result = await reconcileUnregisteredDomains(
      [],
      [page({ customDomainUrl: "https://orphaned.agentwebforms.com" })]
    );
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(0);
  });

  it("never registers the bare managed base domain itself", async () => {
    const result = await reconcileUnregisteredDomains(
      [],
      [page({ customDomainUrl: "https://agentwebforms.com" })]
    );
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
  });

  it("does not register the same host twice when two pages share it", async () => {
    const pages = [
      page({ id: "page-1", customDomainUrl: "https://shared.acme.com" }),
      page({ id: "page-2", customDomainUrl: "https://shared.acme.com" }),
    ];
    const result = await reconcileUnregisteredDomains([], pages);

    expect(mockAddCustomDomain).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(1);
  });

  it("one page's registration failure does not stop the rest — same as the sweep's own per-record isolation", async () => {
    mockAddCustomDomain
      .mockRejectedValueOnce(new Error("Vercel API down"))
      .mockResolvedValueOnce({ id: "d2", domain: "b.acme.com" });

    const pages = [
      page({ id: "page-1", customDomainUrl: "https://a.acme.com" }),
      page({ id: "page-2", customDomainUrl: "https://b.acme.com" }),
    ];
    const result = await reconcileUnregisteredDomains([], pages);

    expect(result.reconciled).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.created).toEqual([{ id: "d2", domain: "b.acme.com" }]);
  });

  it("skips a page missing userId or vercelProjectId — addCustomDomain requires both", async () => {
    const result = await reconcileUnregisteredDomains([], [page({ vercelProjectId: undefined })]);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
  });
});

describe("reconcileUnregisteredDomains — cross-instance race (review finding)", () => {
  beforeEach(() => {
    mockAddCustomDomain.mockReset();
    mockAddCustomDomain.mockResolvedValue({ id: "new-dom", domain: "campaign.acme.com" });
    mockPut.mockReset();
    mockPut.mockReturnValue({ promise: () => Promise.resolve({}) });
  });

  it("claims the domain atomically, with a deterministic id, before ever calling addCustomDomain", async () => {
    await reconcileUnregisteredDomains([], [page()]);

    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ id: "reconcile:campaign.acme.com", domain: "campaign.acme.com" }),
        ConditionExpression: "attribute_not_exists(id)",
      })
    );
    // The claim must land before the Vercel-calling registration, not after.
    const putOrder = mockPut.mock.invocationCallOrder[0];
    const addOrder = mockAddCustomDomain.mock.invocationCallOrder[0];
    expect(putOrder).toBeLessThan(addOrder);
  });

  it("a losing instance backs off cleanly when another instance already claimed the host", async () => {
    // This is the exact race the review flagged: two instances see the same unregistered host
    // in the same sweep. The claim is what makes only one of them proceed.
    mockPut.mockReturnValueOnce({
      promise: () => Promise.reject(new ConditionalCheckFailedException("already claimed")),
    });

    const result = await reconcileUnregisteredDomains([], [page()]);

    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(0);
    expect(result.errors).toBe(0); // losing the race is expected behavior, not a failure
  });

  it("a genuine claim-write failure (not the race) counts as an error and does not call addCustomDomain", async () => {
    mockPut.mockReturnValueOnce({ promise: () => Promise.reject(new Error("DynamoDB throttled")) });

    const result = await reconcileUnregisteredDomains([], [page()]);

    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(result.errors).toBe(1);
  });

  it("two pages sharing a host only attempt the claim once — the in-memory host set still short-circuits", async () => {
    const pages = [
      page({ id: "page-1", customDomainUrl: "https://shared.acme.com" }),
      page({ id: "page-2", customDomainUrl: "https://shared.acme.com" }),
    ];
    await reconcileUnregisteredDomains([], pages);

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockAddCustomDomain).toHaveBeenCalledTimes(1);
  });
});
