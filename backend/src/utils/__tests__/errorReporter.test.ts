/**
 * Tests for errorReporter — focused on the 2026-04-28 stuck-detector cleanup
 * (Bugs 3 + 4): cron-sourced reports go to Backlog and use a per-user title.
 */

// Mock notionService.createOncallItem so we can assert what got sent.
jest.mock("../../services/notionService", () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: "p", notionUrl: "https://notion.so/p" }),
}));

// Mock emailService — sendOncallAlert is a no-op for these tests.
jest.mock("../../services/emailService", () => ({
  emailService: {
    sendOncallAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

// userDb is needed by enrichOnboardingContext when operation starts with `onboarding:`.
jest.mock("../../services/db", () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

import { reportUIError, __clearDedupCacheForTests } from "../errorReporter";
const { createOncallItem } = require("../../services/notionService");

beforeEach(() => {
  jest.clearAllMocks();
  __clearDedupCacheForTests();
});

describe("reportUIError — cron source routing (Bug 3)", () => {
  it("routes to Backlog when context.Source === 'cron'", async () => {
    await reportUIError({
      operation: "onboarding:stuck",
      errorMessage: "stuck at brand_submitted",
      userId: "u1",
      context: {
        Source: "cron",
        Stage: "brand_submitted",
        "Hours Since Last Event": "5.4",
      },
    });
    expect(createOncallItem).toHaveBeenCalledTimes(1);
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.routeToBacklog).toBe(true);
  });

  it("routes to Backlog when operation includes 'stuck' even without Source tag", async () => {
    await reportUIError({
      operation: "onboarding:stuck",
      errorMessage: "x",
      userId: "u1",
      context: {},
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.routeToBacklog).toBe(true);
  });

  it("routes to Backlog when operation includes 'abandoned'", async () => {
    await reportUIError({
      operation: "onboarding:abandoned",
      errorMessage: "x",
      userId: "u1",
      context: { Source: "cron" },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.routeToBacklog).toBe(true);
  });

  it("does NOT route to Backlog for non-cron sources (default oncall)", async () => {
    await reportUIError({
      operation: "agentMode:tool-call-failed",
      errorMessage: "boom",
      userId: "u1",
      context: { Source: "backend" },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.routeToBacklog).toBe(false);
  });
});

describe("reportUIError — cron title format (Bug 4)", () => {
  it("uses per-user title for cron stuck source", async () => {
    await reportUIError({
      operation: "onboarding:stuck",
      errorMessage: "stuck",
      userId: "u1",
      context: {
        Source: "cron",
        "User Email": "harsha@startup.io",
        Stage: "brand_submitted",
        "Hours Since Last Event": "5.43",
      },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.title).toBe(
      "Onboarding stuck: harsha@startup.io @ brand_submitted (5.4h)",
    );
  });

  it("uses per-user title for cron abandoned source", async () => {
    await reportUIError({
      operation: "onboarding:abandoned",
      errorMessage: "abandoned",
      userId: "u1",
      context: {
        Source: "cron",
        "User Email": "rui@startup.io",
        Stage: "goal_selected",
        "Hours Since Last Event": "48.0",
      },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.title).toBe(
      "Onboarding abandoned: rui@startup.io @ goal_selected (48.0h)",
    );
  });

  it("falls back to userId when email is missing", async () => {
    await reportUIError({
      operation: "onboarding:stuck",
      errorMessage: "stuck",
      userId: "user-123",
      context: { Source: "cron", Stage: "brand_submitted" },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.title).toBe(
      "Onboarding stuck: user-123 @ brand_submitted (?h)",
    );
  });

  it("uses '<unknown user>' when neither email nor userId is available", async () => {
    await reportUIError({
      operation: "onboarding:stuck",
      errorMessage: "stuck",
      context: { Source: "cron" },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.title).toContain("<unknown user>");
    expect(arg.title).toContain("unknown");
  });

  it("non-cron sources keep the legacy 'UI Error: …' title", async () => {
    await reportUIError({
      operation: "agentMode:tool-call-failed",
      errorMessage: "boom",
      userId: "u1",
      context: { Source: "backend" },
    });
    const arg = createOncallItem.mock.calls[0][0];
    expect(arg.title).toBe("UI Error: agentMode:tool-call-failed");
  });
});

describe("reportUIError — dedup still works on cron paths", () => {
  it("dedupes the 2nd identical cron call within the 30-min window", async () => {
    const params = {
      operation: "onboarding:stuck",
      errorMessage: "stuck at brand_submitted",
      userId: "u1",
      context: { Source: "cron" },
    };
    await reportUIError(params);
    await reportUIError(params);
    expect(createOncallItem).toHaveBeenCalledTimes(1);
  });
});
