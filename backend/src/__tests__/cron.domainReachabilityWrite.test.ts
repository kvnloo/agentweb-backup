/**
 * ENG-1839 — what the reachability sweep WRITES.
 *
 * `selectDomainsToProbe` was covered; the persistence path was not, and it is the half that
 * can do damage. The invariant it must hold:
 *
 *   The sweep must never write to `status`.
 *
 * `status` is the Vercel VERIFICATION state, owned by addCustomDomain / addSubdomain /
 * verifyDomain. `getProjectDomain` selects `active` then `pending_verification`, so a record
 * set to "error" matches neither and returns null — rendering a live custom domain as "not
 * configured" in the portal. An earlier version of this sweep did exactly that.
 *
 * The failure mode is silent by construction: a malformed UpdateExpression throws
 * ValidationException inside the per-record try, bumps `summary.errors`, logs at warn, and the
 * sweep then does nothing at all — forever, with no test and no alarm. Hence this file.
 */

const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockScan = jest.fn();

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        scan: (...a: unknown[]) => mockScan(...a),
        update: (...a: unknown[]) => mockUpdate(...a),
      })),
    },
  },
}));

const mockProbeDomain = jest.fn();
jest.mock("../services/domainReachabilityService", () => ({
  probeDomain: (...a: unknown[]) => mockProbeDomain(...a),
  decideFromVerdict: jest.requireActual("../services/domainReachabilityService").decideFromVerdict,
}));

import { runDomainReachabilitySweep } from "../cron/domainReachabilityCron";

const DOMAIN = {
  id: "dom-1",
  userId: "user-1",
  domain: "acme.agentwebforms.com",
  vercelProjectId: "proj-1",
  type: "subdomain",
  status: "active",
};
const PAGE = {
  id: "page-1",
  userId: "user-1",
  vercelProjectId: "proj-1",
  status: "deployed",
  customDomainUrl: "https://acme.agentwebforms.com",
};

/** Every attribute name the sweep's UpdateExpression touches, across SET and REMOVE. */
function attributesWritten(): string[] {
  return mockUpdate.mock.calls.flatMap((c: any) => {
    const expr: string = c[0].UpdateExpression;
    const set: string[] = expr.match(/[a-zA-Z][a-zA-Z0-9]*(?=\s*=)/g) ?? [];
    const removed: string[] = (expr.match(/REMOVE\s+([a-zA-Z][a-zA-Z0-9]*)/g) ?? []).map(
      (m: string) => m.split(/\s+/)[1]
    );
    /*
     * ExpressionAttributeNames is where a real attribute name hides. `SET #st = :v` with
     * `{"#st": "status"}` writes `status` while the expression text says "st" — so parsing the
     * expression alone would pass vacuously on exactly the regression this file exists to
     * catch. (The historical bug did use `#status`, which the text scan happens to catch, but
     * that is luck, not coverage.)
     */
    const aliased: string[] = Object.values(c[0].ExpressionAttributeNames ?? {}) as string[];
    return [...set, ...removed, ...aliased];
  });
}

describe("runDomainReachabilitySweep — persistence", () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockScan.mockReset();
    mockProbeDomain.mockReset();
    // scanAll paginates: first call domains, second call pages. No LastEvaluatedKey → one page each.
    mockScan
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [DOMAIN] }) })
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [PAGE] }) });
  });

  it("NEVER writes to `status`, even when confirming a domain unreachable", async () => {
    // Third consecutive failure — the point at which the sweep commits to a verdict, and the
    // exact moment the earlier version corrupted `status`.
    mockScan.mockReset();
    mockScan
      .mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [{ ...DOMAIN, consecutiveFailures: 2 }] }),
      })
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [PAGE] }) });
    mockProbeDomain.mockResolvedValue({
      state: "unreachable",
      reason: "The connection closed during the SSL handshake.",
    });

    const summary = await runDomainReachabilitySweep();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = attributesWritten();
    expect(written).toContain("reachabilityStatus");
    expect(written).not.toContain("status");
    expect(mockUpdate.mock.calls[0][0].ExpressionAttributeValues[":reach"]).toBe("unreachable");
    expect(summary.markedUnhealthy).toBe(1);
  });

  it("stamps the check time but commits no verdict on a first ambiguous failure", async () => {
    /*
     * `suspect`, not `unreachable`. Only ambiguous verdicts go through the confirmation
     * threshold — a definitive failure (a completed TLS handshake that failed) is committed on
     * the first observation, deliberately. DNS that does not resolve is the ambiguous case:
     * it is equally consistent with propagation still in flight.
     */
    mockProbeDomain.mockResolvedValue({ state: "suspect", reason: "DNS did not resolve." });

    const summary = await runDomainReachabilitySweep();

    const written = attributesWritten();
    expect(written).toContain("lastReachabilityCheckAt");
    expect(written).toContain("consecutiveFailures");
    // Below the threshold nothing is asserted about the domain's health...
    expect(written).not.toContain("reachabilityStatus");
    expect(written).not.toContain("status");
    // ...but the timestamp still moves, so a permanently-failing record cannot look
    // unchecked and be re-selected forever.
    expect(summary.stillSuspect).toBe(1);
    expect(summary.markedUnhealthy).toBe(0);
  });

  it("commits the verdict once an ambiguous failure crosses the threshold", async () => {
    /*
     * The suspect→commit crossing, which nothing else pinned. The first test in this file looks
     * like it covers this (it sets consecutiveFailures: 2) but mocks an `unreachable` verdict,
     * which commits immediately and makes the prior count inert. Proof the gap was real:
     * setting UNREACHABLE_CONFIRMATIONS to 999 — a total defeat of the monitor, since no
     * ambiguous failure would ever be reported — left every other test in this file green.
     */
    mockScan.mockReset();
    mockScan
      .mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [{ ...DOMAIN, consecutiveFailures: 2 }] }),
      })
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [PAGE] }) });
    mockProbeDomain.mockResolvedValue({ state: "suspect", reason: "DNS did not resolve." });

    const summary = await runDomainReachabilitySweep();

    const call = mockUpdate.mock.calls[0][0];
    expect(call.ExpressionAttributeValues[":reach"]).toBe("unreachable");
    expect(call.ExpressionAttributeValues[":fails"]).toBe(3);
    expect(attributesWritten()).not.toContain("status");
    expect(summary.markedUnhealthy).toBe(1);
  });

  it("clears the stored error when a previously-unreachable domain recovers", async () => {
    mockScan.mockReset();
    mockScan
      .mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                ...DOMAIN,
                consecutiveFailures: 5,
                reachabilityStatus: "unreachable",
                reachabilityError: "The connection closed during the SSL handshake.",
              },
            ],
          }),
      })
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [PAGE] }) });
    mockProbeDomain.mockResolvedValue({ state: "reachable" });

    const summary = await runDomainReachabilitySweep();

    const call = mockUpdate.mock.calls[0][0];
    // A stale error left behind on a healthy domain is a false alarm the customer cannot clear.
    expect(call.UpdateExpression).toMatch(/REMOVE\s+reachabilityError/);
    expect(call.ExpressionAttributeValues[":reach"]).toBe("reachable");
    expect(call.ExpressionAttributeValues[":fails"]).toBe(0);
    expect(attributesWritten()).not.toContain("status");
    expect(summary.recovered).toBe(1);
  });

  it("keys the write on the record's own id", async () => {
    mockProbeDomain.mockResolvedValue({ state: "reachable" });

    await runDomainReachabilitySweep();

    expect(mockUpdate.mock.calls[0][0].Key).toEqual({ id: "dom-1" });
    expect(mockUpdate.mock.calls[0][0].TableName).toContain("AW-CustomDomains");
  });

  it("counts a failed write as an error instead of aborting the sweep", async () => {
    mockProbeDomain.mockResolvedValue({ state: "reachable" });
    mockUpdate.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("ValidationException: bad expression")),
    });

    const summary = await runDomainReachabilitySweep();

    // One bad record must not stop the other 57 from being checked.
    expect(summary.errors).toBe(1);
  });
});
