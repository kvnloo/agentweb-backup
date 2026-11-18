/**
 * ENG-3095: a deployed page whose stored agentwebforms.com host has no AW-CustomDomains row
 * was invisible to the daily monitor. Two such pages served an expired certificate from August
 * to November 2026. The sweep now finds these hosts, probes them, and reports them in the log
 * and in one internal alert per run. It writes nothing for them.
 */

const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockScan = jest.fn();

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        scan: (...a: unknown[]) => mockScan(...a),
        update: (...a: unknown[]) => mockUpdate(...a),
        put: (...a: unknown[]) => mockPut(...a),
      })),
    },
  },
}));

const mockProbeDomain = jest.fn();
jest.mock("../services/domainReachabilityService", () => ({
  probeDomain: (...a: unknown[]) => mockProbeDomain(...a),
  decideFromVerdict: jest.requireActual("../services/domainReachabilityService").decideFromVerdict,
  UNREACHABLE_CONFIRMATIONS: jest.requireActual("../services/domainReachabilityService")
    .UNREACHABLE_CONFIRMATIONS,
}));

const mockAddCustomDomain = jest.fn();
jest.mock("../services/customDomainService", () => ({
  addCustomDomain: (...a: unknown[]) => mockAddCustomDomain(...a),
  SUBDOMAIN_BASE: "agentwebforms.com",
}));

const mockSendOncallAlert = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/emailService", () => ({
  emailService: { sendOncallAlert: (...a: unknown[]) => mockSendOncallAlert(...a) },
}));

import {
  runDomainReachabilitySweep,
  selectRowlessManagedHosts,
} from "../cron/domainReachabilityCron";

const ROW = {
  id: "dom-1",
  userId: "user-1",
  domain: "has-row.agentwebforms.com",
  vercelProjectId: "proj-1",
  type: "subdomain",
  status: "active",
};
const PAGE_WITH_ROW = {
  id: "page-with-row",
  userId: "user-1",
  vercelProjectId: "proj-1",
  status: "deployed",
  customDomainUrl: "https://has-row.agentwebforms.com",
};
const PAGE_EXPIRED = {
  id: "page-expired",
  userId: "user-2",
  vercelProjectId: "proj-2",
  status: "deployed",
  customDomainUrl: "https://expired-cert.agentwebforms.com/some/path",
};
/** Like the two NuErraa pages on ENG-3080: answering, and no vercelProjectId on the record. */
const PAGE_ANSWERS = {
  id: "page-answers",
  userId: "user-3",
  status: "deployed",
  customDomainUrl: "https://answers.agentwebforms.com",
};

const EXPIRED = { state: "suspect", reason: "certificate has expired", code: "CERT_HAS_EXPIRED" };
const OK = { state: "reachable", httpStatus: 200 };

function seed(domains: unknown[], pages: unknown[]) {
  mockScan.mockImplementation((params: { TableName: string }) => ({
    promise: () =>
      Promise.resolve({ Items: params.TableName.includes("CustomDomains") ? domains : pages }),
  }));
}

function probeBy(map: Record<string, unknown | unknown[]>) {
  const calls: Record<string, number> = {};
  mockProbeDomain.mockImplementation(async (host: string) => {
    const reply = map[host];
    if (reply === undefined) throw new Error(`unexpected probe of ${host}`);
    const n = (calls[host] = (calls[host] ?? 0) + 1);
    return Array.isArray(reply) ? reply[Math.min(n, reply.length) - 1] : reply;
  });
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const rowlessLine = () =>
  logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("rowless-managed-hosts="));

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("selectRowlessManagedHosts", () => {
  it("returns deployed pages whose managed host has no domain row, by host not by full URL", () => {
    expect(selectRowlessManagedHosts([ROW], [PAGE_WITH_ROW, PAGE_EXPIRED, PAGE_ANSWERS])).toEqual([
      { pageId: "page-expired", host: "expired-cert.agentwebforms.com" },
      { pageId: "page-answers", host: "answers.agentwebforms.com" },
    ]);
  });

  it("leaves out pages that are not deployed, custom hosts, and unparseable URLs", () => {
    const pages = [
      { ...PAGE_EXPIRED, id: "draft", status: "building" },
      { ...PAGE_EXPIRED, id: "custom", customDomainUrl: "https://www.customer-site.com" },
      { ...PAGE_EXPIRED, id: "junk", customDomainUrl: "not a url" },
      { ...PAGE_EXPIRED, id: "none", customDomainUrl: undefined },
      { ...PAGE_EXPIRED, id: "lookalike", customDomainUrl: "https://evilagentwebforms.com" },
    ];
    expect(selectRowlessManagedHosts([ROW], pages)).toEqual([]);
  });

  it("leaves out a sandbox (eval_) user's page (ENG-1907)", () => {
    expect(
      selectRowlessManagedHosts([ROW], [{ ...PAGE_EXPIRED, id: "sandbox", userId: "eval_abc" }, PAGE_ANSWERS])
    ).toEqual([{ pageId: "page-answers", host: "answers.agentwebforms.com" }]);
  });
});

describe("runDomainReachabilitySweep, row-less managed hosts (ENG-3095)", () => {
  it("probes every row-less managed host with the monitor's probe", async () => {
    seed([ROW], [PAGE_WITH_ROW, PAGE_EXPIRED, PAGE_ANSWERS]);
    probeBy({
      "has-row.agentwebforms.com": OK,
      "expired-cert.agentwebforms.com": EXPIRED,
      "answers.agentwebforms.com": OK,
    });

    const summary = await runDomainReachabilitySweep();

    const probed = mockProbeDomain.mock.calls.map((c) => c[0]);
    expect(probed).toContain("expired-cert.agentwebforms.com");
    expect(probed).toContain("answers.agentwebforms.com");
    expect(summary.rowlessManagedHosts).toBe(2);
    expect(summary.rowlessManagedFailing).toBe(1);
  });

  it("logs one line with the count and, per host, the page id, host and result; a failure reads differently from an answer", async () => {
    seed([ROW], [PAGE_WITH_ROW, PAGE_EXPIRED, PAGE_ANSWERS]);
    probeBy({
      "has-row.agentwebforms.com": OK,
      "expired-cert.agentwebforms.com": EXPIRED,
      "answers.agentwebforms.com": OK,
    });

    await runDomainReachabilitySweep();

    const lines = rowlessLine();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("rowless-managed-hosts=2 failing=1");
    expect(lines[0]).toContain(
      "page=page-expired host=expired-cert.agentwebforms.com result=FAILED(suspect CERT_HAS_EXPIRED)"
    );
    expect(lines[0]).toContain("page=page-answers host=answers.agentwebforms.com result=ok(200)");
    expect(lines[0]).not.toContain("has-row.agentwebforms.com");
  });

  it("writes nothing for a row-less host: no put, and the only update is the host that has a row", async () => {
    seed([ROW], [PAGE_WITH_ROW, PAGE_EXPIRED, PAGE_ANSWERS]);
    probeBy({
      "has-row.agentwebforms.com": OK,
      "expired-cert.agentwebforms.com": EXPIRED,
      "answers.agentwebforms.com": OK,
    });

    await runDomainReachabilitySweep();

    expect(mockPut).not.toHaveBeenCalled();
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].Key).toEqual({ id: "dom-1" });
    expect(mockUpdate.mock.calls[0][0].TableName).toContain("CustomDomains");
  });

  it("sends ONE internal alert per run listing every failing host, and no answering host", async () => {
    const second = { ...PAGE_EXPIRED, id: "page-expired-2", customDomainUrl: "https://expired-two.agentwebforms.com" };
    seed([ROW], [PAGE_WITH_ROW, PAGE_EXPIRED, second, PAGE_ANSWERS]);
    probeBy({
      "has-row.agentwebforms.com": OK,
      "expired-cert.agentwebforms.com": EXPIRED,
      "expired-two.agentwebforms.com": EXPIRED,
      "answers.agentwebforms.com": OK,
    });

    await runDomainReachabilitySweep();

    expect(mockSendOncallAlert).toHaveBeenCalledTimes(1);
    const [subject, message] = mockSendOncallAlert.mock.calls[0];
    expect(subject).toContain("2 landing-page host(s)");
    expect(message).toContain("page=page-expired host=expired-cert.agentwebforms.com");
    expect(message).toContain("page=page-expired-2 host=expired-two.agentwebforms.com");
    expect(message).not.toContain("answers.agentwebforms.com");
  });

  it("sends no alert when every row-less host answers", async () => {
    seed([ROW], [PAGE_WITH_ROW, PAGE_ANSWERS]);
    probeBy({ "has-row.agentwebforms.com": OK, "answers.agentwebforms.com": OK });

    const summary = await runDomainReachabilitySweep();

    expect(mockSendOncallAlert).not.toHaveBeenCalled();
    expect(rowlessLine()[0]).toContain("rowless-managed-hosts=1 failing=0");
    expect(summary.rowlessManagedFailing).toBe(0);
  });

  it("does not report a host that fails once and answers on the immediate second probe", async () => {
    seed([], [PAGE_EXPIRED]);
    probeBy({ "expired-cert.agentwebforms.com": [{ state: "suspect", reason: "reset", code: "ECONNRESET" }, OK] });

    const summary = await runDomainReachabilitySweep();

    expect(mockProbeDomain).toHaveBeenCalledTimes(2);
    expect(summary.rowlessManagedFailing).toBe(0);
    expect(mockSendOncallAlert).not.toHaveBeenCalled();
  });

  it("with no row-less hosts: logs a zero count, probes nothing extra, sends nothing", async () => {
    seed([ROW], [PAGE_WITH_ROW]);
    probeBy({ "has-row.agentwebforms.com": OK });

    const summary = await runDomainReachabilitySweep();

    expect(mockProbeDomain).toHaveBeenCalledTimes(1);
    expect(rowlessLine()).toEqual(["[DomainReachability] rowless-managed-hosts=0 failing=0"]);
    expect(mockSendOncallAlert).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ probed: 1, reachable: 1, errors: 0, rowlessManagedHosts: 0 });
  });

  it("a failing alert send does not fail the sweep", async () => {
    seed([], [PAGE_EXPIRED]);
    probeBy({ "expired-cert.agentwebforms.com": EXPIRED });
    mockSendOncallAlert.mockRejectedValueOnce(new Error("smtp down"));

    const summary = await runDomainReachabilitySweep();

    expect(summary.rowlessManagedFailing).toBe(1);
    expect(summary.errors).toBe(1);
  });
});
