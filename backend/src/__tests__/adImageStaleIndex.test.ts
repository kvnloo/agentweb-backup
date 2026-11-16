/**
 * ENG-2308: an ad-image restart must not be abandoned because the user row it
 * re-reads at the start of the run is still the PREVIOUS run's.
 *
 * Found in production: after a run failed, a restart left the axis `running`
 * until its timeout and nothing was ever written. `triggerAdImageGenerationForUser`
 * re-reads the user with `getUserById`, which queries the UserIdIndex GSI. A GSI
 * is eventually consistent, so milliseconds after the claim it can still return
 * the previous run's `adImageRunId`; the run then concluded "a newer run owns the
 * axis", logged "abandoning run" and returned without publishing a terminal state.
 * `failAdImageRunIfOwned` reads the same way and could drop its own failure.
 *
 * These tests run the real service and the real `userDb.updateUser` against the
 * in-memory DynamoDB, with the index deliberately serving the pre-claim row while
 * base-table reads return the current one.
 */

jest.mock("aws-sdk", () => {
  const { createFakeDocClient } = require("./helpers/fakeDocClient");
  const table = { row: {}, updates: [] as any[] };
  (global as any).__adTable = table;
  const client = createFakeDocClient(table);
  const inert = () => new Proxy({}, { get: () => jest.fn(() => ({ promise: async () => ({}) })) });
  const sdk: any = new Proxy(
    { DynamoDB: { DocumentClient: jest.fn(() => client) }, config: { update: jest.fn() } },
    { get: (target: any, key) => (key in target ? target[key] : jest.fn(inert)) },
  );
  sdk.default = sdk;
  return sdk;
});
jest.mock("../utils/errorReporter", () => ({ reportUIError: jest.fn(async () => undefined) }));
jest.mock("../services/creativeRubricOnboarding", () => ({ judgeOnboardingAdImages: jest.fn(async () => null) }));
jest.mock("../services/onboardingAdImageChatSessionMirror", () => ({
  mirrorOnboardingAdImagesToChatSession: jest.fn().mockResolvedValue("mocked-session"),
}));

import {
  claimAdImageRun,
  triggerAdImageGenerationForUser,
} from "../services/onboardingAdImageService";
import type { FakeTable } from "./helpers/fakeDocClient";

const table = (): FakeTable => (global as any).__adTable;

const PRIOR = {
  adImageStatus: "failed",
  adImageRunId: "run-from-the-previous-attempt",
  adImageStartedAt: "2026-10-09T10:00:00.000Z",
  adImageCompletedAt: "2026-10-09T10:00:01.000Z",
  adImageError: "no brand logo is saved in Brand Guidelines — upload your logo",
};

function seed(brandData: Record<string, unknown>) {
  const t = table();
  t.updates = [];
  t.beforeUpdate = undefined;
  t.row = {
    userId: "u1",
    email: "founder@acme.com",
    companyName: "Acme",
    productDomain: "https://acme.com",
    creativeDirStatus: "ready",
    creativeDirResult: { concepts: [], copy_angles: [], format_archetypes: [] },
    icpResult: [{ id: "icp_0", name: "P0", pain: "p", desire: "d", objection: "o", meta_targeting_brief: "b" }],
    brandGuidelines: { brandData: { brandName: "Acme", ...brandData } },
    ...PRIOR,
  };
  // The index still serves the row as it was BEFORE the restart's claim.
  t.indexRow = JSON.parse(JSON.stringify(t.row));
}

describe("ad-image restart while the UserIdIndex still shows the previous run", () => {
  it("publishes the failure for the restarted run instead of silently abandoning it", async () => {
    seed({}); // no logo -> the run fails on the missing-logo gate
    const run = await claimAdImageRun("u1");
    expect(run).not.toBeNull();
    expect(table().row.adImageStatus).toBe("running");
    expect(table().row.adImageRunId).toBe(run!.runId);
    // The claim cleared the previous attempt's error.
    expect("adImageError" in table().row).toBe(false);

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await triggerAdImageGenerationForUser("u1", { run: run! });
    const warned = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    err.mockRestore();

    expect(warned.some((m) => m.includes("abandoning run"))).toBe(false);
    expect(table().row.adImageStatus).toBe("failed");
    expect(String(table().row.adImageError)).toMatch(/no brand logo/);
    // ...and it is still THIS run's record.
    expect(table().row.adImageRunId).toBe(run!.runId);
  });

  it("does not drop its own failure on the stale index when the gate fires after the start check", async () => {
    // creative direction not ready: a different gate, which reports through the
    // same failAdImageRunIfOwned read.
    seed({ logoUrl: "https://acme.com/logo.png" });
    table().row.creativeDirStatus = "idle";
    table().indexRow = JSON.parse(JSON.stringify(table().row));
    const run = await claimAdImageRun("u1");

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await triggerAdImageGenerationForUser("u1", { run: run! });
    warn.mockRestore();
    err.mockRestore();

    expect(table().row.adImageStatus).toBe("failed");
    expect(String(table().row.adImageError)).toMatch(/creative direction not ready/);
  });

  it("still refuses to publish over a genuinely newer run", async () => {
    seed({});
    const first = await claimAdImageRun("u1");
    // A second restart claims the axis before the first run's worker gets going.
    table().row = {
      ...table().row,
      adImageStatus: "running",
      adImageRunId: "a-genuinely-newer-run",
      adImageStartedAt: "2099-01-01T00:00:00.000Z",
    };
    table().indexRow = JSON.parse(JSON.stringify(table().row));

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await triggerAdImageGenerationForUser("u1", { run: first! });
    warn.mockRestore();

    expect(table().row.adImageStatus).toBe("running");
    expect(table().row.adImageRunId).toBe("a-genuinely-newer-run");
  });
});
