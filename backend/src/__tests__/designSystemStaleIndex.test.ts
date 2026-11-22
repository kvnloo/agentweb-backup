/**
 * A design-system build that finishes right after a restart must publish its
 * result even while the UserIdIndex still shows the previous attempt.
 *
 * The build reads `designSystem` back before writing its terminal state, and
 * `buildReadyPatch` returns nothing unless the status it reads is `running`. That
 * read went through the UserIdIndex GSI, which is eventually consistent: right
 * after a retry claimed the axis it can still serve the previous attempt's
 * `failed`, so the ready write was skipped and the build sat in `running` until
 * the watchdog failed it minutes later. (The same shape that left the ad-image
 * axis stuck.) The start route's response had the same flaw: it read the row back
 * and reported the stale `failed` to the UI that had just asked to retry.
 *
 * These run the real service and routes with the real `userDb.updateUser` against
 * the in-memory DynamoDB, the index deliberately serving the pre-claim row.
 */

jest.mock("aws-sdk", () => {
  const { createFakeDocClient } = require("./helpers/fakeDocClient");
  const table = { row: {}, updates: [] as any[] };
  (global as any).__dsTable = table;
  const client = createFakeDocClient(table);
  const inert = () => new Proxy({}, { get: () => jest.fn(() => ({ promise: async () => ({}) })) });
  const sdk: any = new Proxy(
    { DynamoDB: { DocumentClient: jest.fn(() => client) }, config: { update: jest.fn() } },
    { get: (target: any, key) => (key in target ? target[key] : jest.fn(inert)) },
  );
  sdk.default = sdk;
  return sdk;
});
jest.mock("../services/db", () => {
  const actual = jest.requireActual("../services/db");
  return {
    ...actual,
    taskDb: { createTask: jest.fn(async () => undefined), getTaskById: jest.fn(async () => null) },
  };
});
jest.mock("../services/onboardingDesignSystemService", () => {
  const actual = jest.requireActual("../services/onboardingDesignSystemService");
  return { ...actual, triggerDesignSystemBuildForUser: jest.fn(actual.triggerDesignSystemBuildForUser) };
});
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "u1", email: "founder@acme.com", isAdmin: false };
    next();
  },
}));

import express from "express";
import request from "supertest";
import designSystemRoutes from "../routes/designSystemBuild";
import { triggerDesignSystemBuildForUser } from "../services/onboardingDesignSystemService";
import type { FakeTable } from "./helpers/fakeDocClient";

const app = express();
app.use(express.json());
app.use("/api/onboarding", designSystemRoutes);

const table = (): FakeTable => (global as any).__dsTable;

const FAILED_BEFORE = {
  status: "failed",
  startedAt: "2026-10-12T09:00:00.000Z",
  completedAt: "2026-10-12T09:00:05.000Z",
  durationMs: 5000,
  error: "scrape failed",
};

function seed(designSystem: Record<string, unknown>) {
  const t = table();
  t.updates = [];
  t.beforeUpdate = undefined;
  t.row = { userId: "u1", email: "founder@acme.com", companyName: "Acme", designSystem };
  // The index still serves the row as it was BEFORE the retry claimed the axis.
  t.indexRow = JSON.parse(JSON.stringify({ ...t.row, designSystem: FAILED_BEFORE }));
}

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const spies = [jest.spyOn(console, "warn").mockImplementation(() => {}), jest.spyOn(console, "error").mockImplementation(() => {})];
  try {
    return await run();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
};

describe("design-system build right after a retry, with the index one attempt behind", () => {
  it("publishes `ready` instead of leaving the build running", async () => {
    seed({ status: "running", startedAt: "2026-10-12T10:00:00.000Z", kbTaskId: "kb-1" });

    // No website on the account: the quick manual-fallback path, which is the one
    // that finishes within the index's lag window.
    await quietly(() =>
      triggerDesignSystemBuildForUser("u1", { updateKnowledgeBaseFile: async () => ({ success: true }) as any }),
    );

    expect(table().row.designSystem.status).toBe("ready");
    expect(table().row.designSystem.source).toBe("manual_fallback");
  });

  it("publishes `failed` for a build whose fallback also failed", async () => {
    seed({ status: "running", startedAt: "2026-10-12T10:00:00.000Z", kbTaskId: "kb-1" });

    await quietly(() =>
      triggerDesignSystemBuildForUser("u1", { updateKnowledgeBaseFile: async () => ({ success: false, error: "kb down" }) as any }),
    );

    expect(table().row.designSystem.status).toBe("failed");
    expect(String(table().row.designSystem.error)).toMatch(/kb down/);
  });
});

describe("POST /design-system/start right after a failure", () => {
  it("answers `running` for the build it just started, not the failed one the index still shows", async () => {
    seed({ ...FAILED_BEFORE });
    table().indexRow = JSON.parse(JSON.stringify(table().row)); // index and base agree: failed

    (triggerDesignSystemBuildForUser as jest.Mock).mockImplementationOnce(async () => undefined);
    const res = await quietly(() => request(app).post("/api/onboarding/design-system/start"));

    expect(res.status).toBe(200);
    expect(res.body.status.status).toBe("running");
  });
});
