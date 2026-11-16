import {
  classifyTestsCheck,
  evaluateRequiredTestsGate,
  runPublishGateVerifier,
  NotVerifierOwnedError,
  VERIFIER_OWNED_TAG,
  type TestsCheckRun,
} from "../services/publishGateVerifier";

const SHA = "a".repeat(40);
const input = { pageId: "verifier-page", branch: "draft/agentweb-preview", sha: SHA };

function deps(checkRuns: TestsCheckRun[], opts: { tags?: string[]; publishThrows?: boolean } = {}) {
  return {
    getPage: jest.fn().mockResolvedValue({ id: input.pageId, tags: opts.tags ?? [VERIFIER_OWNED_TAG] }),
    getCheckRuns: jest.fn().mockResolvedValue(checkRuns),
    publish: jest.fn(opts.publishThrows ? () => Promise.reject(new Error("merge failed")) : () => Promise.resolve()),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

describe("ENG-2794 publish-gate verifier harness", () => {
  it.each<[string, TestsCheckRun[], string, string]>([
    ["missing", [{ name: "Vercel", status: "completed", conclusion: "success" }], "missing", "required_tests_pending"],
    ["pending", [{ name: "Tests", status: "in_progress", conclusion: null }], "pending", "required_tests_pending"],
    ["cancelled", [{ name: "Tests", status: "completed", conclusion: "cancelled" }], "pending", "required_tests_pending"],
    ["failed", [{ name: "Tests", status: "completed", conclusion: "failure" }], "failed", "required_tests_failed"],
  ])("%s Tests check -> 409 and main is never updated", async (_l, runs, state, error) => {
    const d = deps(runs);
    const r = await runPublishGateVerifier(input, d);
    expect(r).toMatchObject({ observedState: state, httpStatus: 409, error, published: false });
    expect(d.getCheckRuns).toHaveBeenCalledWith(SHA);
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.rollback).not.toHaveBeenCalled();
  });

  it("passed Tests check -> publish invoked exactly once at the exact SHA", async () => {
    const d = deps([{ name: "Tests", status: "completed", conclusion: "success" }]);
    const r = await runPublishGateVerifier(input, d);
    expect(r).toMatchObject({ observedState: "passed", httpStatus: 200, published: true, rolledBack: false });
    expect(d.publish).toHaveBeenCalledTimes(1);
    expect(d.publish).toHaveBeenCalledWith(input);
    expect(d.rollback).not.toHaveBeenCalled();
  });

  it("publish failure after a pass -> rollback path runs once", async () => {
    const d = deps([{ name: "Tests", status: "completed", conclusion: "success" }], { publishThrows: true });
    const r = await runPublishGateVerifier(input, d);
    expect(r).toMatchObject({ httpStatus: 500, published: false, rolledBack: true });
    expect(d.rollback).toHaveBeenCalledTimes(1);
  });

  it("refuses a page not tagged verifier-owned, before reading checks or publishing", async () => {
    const d = deps([{ name: "Tests", status: "completed", conclusion: "success" }], { tags: ["customer"] });
    await expect(runPublishGateVerifier(input, d)).rejects.toBeInstanceOf(NotVerifierOwnedError);
    expect(d.getCheckRuns).not.toHaveBeenCalled();
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("refuses an unknown page and a non-SHA ref", async () => {
    const d = deps([]);
    d.getPage.mockResolvedValue(null);
    await expect(runPublishGateVerifier(input, d)).rejects.toBeInstanceOf(NotVerifierOwnedError);
    await expect(runPublishGateVerifier({ ...input, sha: "main" }, deps([]))).rejects.toThrow(/exact commit SHA/);
  });

  it("gate decision: no-CI bypass allows, classification matches", () => {
    expect(evaluateRequiredTestsGate(undefined, true)).toEqual({ allow: true, state: "no_ci" });
    expect(classifyTestsCheck({ name: "Tests", status: "completed", conclusion: "success" })).toBe("passed");
  });
});
