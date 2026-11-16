/**
 * ENG-2794 (ENG-1496.1): publish-gate verifier harness.
 *
 * The landing-page publish route (routes/landingPageGeneration.ts, ENG-1488) refuses to advance
 * `main` until the draft's exact-SHA "Tests" check has completed successfully. This module owns
 * that decision as a pure function — the route calls it, so the harness below exercises the
 * same logic, not a copy — and adds a verifier that drives the gate against an injected
 * check-state client so it can be proven without a real fixture page or production writes.
 */

export type TestsCheckState = "missing" | "pending" | "failed" | "passed";

export interface TestsCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

export type RequiredTestsGateDecision =
  | { allow: true; state: TestsCheckState | "no_ci" }
  | { allow: false; state: TestsCheckState; status: 409; error: string; message: string };

/** Classify the draft's "Tests" check exactly as the publish gate reads it. */
export function classifyTestsCheck(testsCheck: TestsCheckRun | undefined): TestsCheckState {
  if (!testsCheck) return "missing";
  if (testsCheck.status !== "completed" || testsCheck.conclusion === "cancelled") return "pending";
  if (testsCheck.conclusion !== "success") return "failed";
  return "passed";
}

/**
 * The ENG-1488 gate decision. `noCiAtAll` is true only when the repo provably cannot produce a
 * Tests check (no non-benign check runs and zero workflows) — the caller fails closed otherwise.
 */
export function evaluateRequiredTestsGate(
  testsCheck: TestsCheckRun | undefined,
  noCiAtAll: boolean
): RequiredTestsGateDecision {
  if (noCiAtAll) return { allow: true, state: "no_ci" };
  const state = classifyTestsCheck(testsCheck);
  if (state === "missing") {
    return {
      allow: false, state, status: 409, error: "required_tests_pending",
      message: "Required Tests check has not started for this draft yet. Keep the draft and retry publish after GitHub starts it.",
    };
  }
  if (state === "pending") {
    return {
      allow: false, state, status: 409, error: "required_tests_pending",
      message: testsCheck?.conclusion === "cancelled"
        ? "Required Tests check was cancelled for this draft. Keep the draft and retry publish after Tests runs again."
        : "Required Tests check is still running for this draft. Keep the draft and retry publish when it completes.",
    };
  }
  if (state === "failed") {
    return {
      allow: false, state, status: 409, error: "required_tests_failed",
      message: "Required Tests check failed for this draft. Fix the draft and retry publish after Tests passes.",
    };
  }
  return { allow: true, state };
}

/** Tag a page must carry before the verifier will touch it (customer-content guard). */
export const VERIFIER_OWNED_TAG = "publish-gate-verifier";

export interface VerifierPage {
  id: string;
  tags?: string[];
}

export interface PublishGateVerifierDeps {
  /** Loads page metadata (tags) for the guard. */
  getPage(pageId: string): Promise<VerifierPage | null>;
  /** Returns check runs for the exact SHA — mocked in tests, read-only GitHub in a real run. */
  getCheckRuns(sha: string): Promise<TestsCheckRun[]>;
  /** Advances main to the exact SHA. Must not be invoked unless the gate allows. */
  publish(args: { pageId: string; branch: string; sha: string }): Promise<void>;
  /** Restores the previous main ref if publish throws. */
  rollback(args: { pageId: string; branch: string; sha: string; error: unknown }): Promise<void>;
}

export interface PublishGateVerifierResult {
  pageId: string;
  branch: string;
  sha: string;
  observedState: TestsCheckState;
  httpStatus: 200 | 409 | 500;
  error?: string;
  published: boolean;
  rolledBack: boolean;
}

export class NotVerifierOwnedError extends Error {
  constructor(pageId: string) {
    super(`Page ${pageId} is not tagged "${VERIFIER_OWNED_TAG}"; the publish-gate verifier refuses to run against customer content.`);
    this.name = "NotVerifierOwnedError";
  }
}

export async function runPublishGateVerifier(
  input: { pageId: string; branch: string; sha: string },
  deps: PublishGateVerifierDeps
): Promise<PublishGateVerifierResult> {
  const { pageId, branch, sha } = input;
  if (!pageId || !branch || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("runPublishGateVerifier requires pageId, branch, and an exact commit SHA");
  }

  const page = await deps.getPage(pageId);
  if (!page || !(page.tags ?? []).includes(VERIFIER_OWNED_TAG)) {
    throw new NotVerifierOwnedError(pageId);
  }

  const checkRuns = await deps.getCheckRuns(sha);
  const testsCheck = checkRuns.find((check) => check.name === "Tests");
  // The verifier fixture always runs CI, so it never takes the no-CI bypass.
  const decision = evaluateRequiredTestsGate(testsCheck, false);
  const observedState = classifyTestsCheck(testsCheck);
  const base = { pageId, branch, sha, observedState };

  if (!decision.allow) {
    return { ...base, httpStatus: 409, error: decision.error, published: false, rolledBack: false };
  }

  try {
    await deps.publish({ pageId, branch, sha });
    return { ...base, httpStatus: 200, published: true, rolledBack: false };
  } catch (error) {
    await deps.rollback({ pageId, branch, sha, error });
    return { ...base, httpStatus: 500, error: "publish_failed_rolled_back", published: false, rolledBack: true };
  }
}
