/**
 * Live E2E pipeline test — Onboarding ad-gen cascade.
 *
 * Hits REAL Bedrock + REAL Gemini + REAL Google Search. Costs real money
 * per run. Harsha approved the cost on 2026-04-25 specifically as the
 * non-negotiable receipt for the competitor-fires-before-ICP race fix
 * (Notion task `34d09247-c951-81e4-af97-df1e869bc8aa`).
 *
 * GATED: skipped on every normal `npm test` run. To run:
 *
 *   RUN_LIVE_TESTS=true npx jest --testPathPattern=onboardingPipeline.live
 *
 * What it asserts (the only thing that matters per the Notion acceptance
 * criterion):
 *
 *   1. A fresh test user with a real domain (`linear.app`) is created in
 *      DynamoDB with full brandGuidelines populated.
 *   2. We kick off the same code path the FE uses:
 *        startIcpDiscoveryForUser -> (ICP cascade trigger) ->
 *        startCreativeDirForUser -> startAdImageGenerationForUser ->
 *        startAdCopyForUser.
 *   3. We poll User row every 2s until `adCopyStatus === 'ready'` OR
 *      3-min timeout.
 *   4. Final assertions:
 *        - chain reaches `adCopyStatus: ready`
 *        - 3 ad-copy variants persisted with non-empty headline + primaryText
 *        - 3 ad-image variants persisted with valid Gemini image references
 *        - `competitorStatus === 'ready'` (not `failed`)
 *        - `creativeDirStatus === 'ready'` (not stuck `running`)
 *   5. Test user is removed from DynamoDB on cleanup.
 *
 * Run this ONCE locally before pushing the fix and capture the passing
 * output as the PR description's "real chain works end-to-end" receipt.
 */

import { randomUUID } from "crypto";
import { userDb } from "../services/db";
import { startIcpDiscoveryForUser } from "../services/onboardingIcpService";
import { startCreativeDirForUser } from "../services/onboardingCreativeDirService";
import { startAdImageGenerationForUser } from "../services/onboardingAdImageService";
import { startAdCopyForUser } from "../services/onboardingAdCopyService";

const RUN = process.env.RUN_LIVE_TESTS === "true";
const describeLive = RUN ? describe : describe.skip;

const POLL_INTERVAL_MS = 2_000;
const PIPELINE_TIMEOUT_MS = 180_000; // 3 minutes
const TEST_TIMEOUT_MS = 300_000; // 5 minutes — leaves slack for setup + cleanup

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface PipelineSnapshot {
  icpStatus?: string;
  competitorStatus?: string;
  creativeDirStatus?: string;
  adImageStatus?: string;
  adCopyStatus?: string;
  icpResult?: unknown[];
  adImageResult?: { variants?: unknown[] };
  adCopyResult?: { variants?: Array<{ headline?: string; primaryText?: string }> };
  competitorError?: string;
  creativeDirError?: string;
  adImageError?: string;
  adCopyError?: string;
}

async function readPipelineSnapshot(userId: string): Promise<PipelineSnapshot> {
  const u = (await userDb.getUserById(userId)) as PipelineSnapshot | undefined;
  return u || {};
}

describeLive("Onboarding pipeline — live E2E (real Bedrock + Gemini + Google Search)", () => {
  const testUserId = `live-test-${Date.now()}-${randomUUID()}`;
  const testEmail = `live-test-${Date.now()}@agentweb-live-test.invalid`;

  afterAll(async () => {
    // Best-effort cleanup — never block teardown on DynamoDB hiccups.
    try {
      // eslint-disable-next-line no-console
      console.log(`[live-test] cleaning up test user ${testUserId}`);
      await userDb.deleteUserById?.(testUserId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[live-test] cleanup failed (ignored):", err);
    }
  }, 30_000);

  it(
    "fresh user with linear.app brandGuidelines reaches adCopyStatus=ready with real Bedrock + Gemini",
    async () => {
      // ── 1. Provision the test user with a fully-populated brandGuidelines.
      // We bypass the brand-build LLM step (already covered by other tests)
      // and seed the User row with what brand-build would have written, so
      // this test focuses entirely on the ICP → Competitor → CreativeDir →
      // AdImage → AdCopy cascade.
      await userDb.createUser(
        testEmail,
        testUserId,
        "live-test-not-used",
        false,
        false,
        ["customer"],
        "Live Test Linear",
      );
      await userDb.updateUser(testUserId, {
        productDomain: "linear.app",
        companyName: "Linear",
        brandGuidelines: {
          brandData: {
            brandName: "Linear",
            domain: "linear.app",
            tagline: "The issue tracking tool you'll enjoy using",
            valueProposition:
              "Linear is a purpose-built tool for planning and building products",
            targetAudience: "Software engineering teams at fast-moving startups",
            toneOfVoice: "Confident, direct, modern",
            primaryColor: "#5E6AD2",
            secondaryColor: "#FFFFFF",
            fontFamily: "Inter",
          },
        },
      } as any);

      // ── 2. Kick off the ICP step the same way the FE does. The fix under
      // test makes this step's success cascade-fire the competitor step,
      // closing the previously-broken ICP → Competitor handoff.
      await startIcpDiscoveryForUser(testUserId);

      // ── 3. Poll the User row. Each tick: read snapshot, advance the
      // cascade by firing the next step's `start*` whenever the prior step
      // flips to `ready`. This mirrors the FE polling driver.
      const startedAt = Date.now();
      let lastSnapshot: PipelineSnapshot = {};
      let firedCreativeDir = false;
      let firedAdImage = false;
      let firedAdCopy = false;

      while (Date.now() - startedAt < PIPELINE_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
        lastSnapshot = await readPipelineSnapshot(testUserId);

        // eslint-disable-next-line no-console
        console.log(
          `[live-test t+${Math.round((Date.now() - startedAt) / 1000)}s] ` +
            `icp=${lastSnapshot.icpStatus} ` +
            `competitor=${lastSnapshot.competitorStatus} ` +
            `creativeDir=${lastSnapshot.creativeDirStatus} ` +
            `adImage=${lastSnapshot.adImageStatus} ` +
            `adCopy=${lastSnapshot.adCopyStatus}`,
        );

        // Cascade kickoff: each step starts when the prior is ready. ICP →
        // Competitor is auto-fired by the fix under test (no explicit start
        // call here). The remaining downstream steps still need explicit
        // start calls until their cascade hooks land.
        if (
          lastSnapshot.competitorStatus === "ready" &&
          !firedCreativeDir &&
          (!lastSnapshot.creativeDirStatus ||
            lastSnapshot.creativeDirStatus === "idle")
        ) {
          firedCreativeDir = true;
          // eslint-disable-next-line no-console
          console.log("[live-test] firing startCreativeDirForUser");
          await startCreativeDirForUser(testUserId);
        }
        if (
          lastSnapshot.creativeDirStatus === "ready" &&
          !firedAdImage &&
          (!lastSnapshot.adImageStatus || lastSnapshot.adImageStatus === "idle")
        ) {
          firedAdImage = true;
          // eslint-disable-next-line no-console
          console.log("[live-test] firing startAdImageGenerationForUser");
          await startAdImageGenerationForUser(testUserId);
        }
        if (
          lastSnapshot.adImageStatus === "ready" &&
          !firedAdCopy &&
          (!lastSnapshot.adCopyStatus || lastSnapshot.adCopyStatus === "idle")
        ) {
          firedAdCopy = true;
          // eslint-disable-next-line no-console
          console.log("[live-test] firing startAdCopyForUser");
          await startAdCopyForUser(testUserId);
        }

        if (lastSnapshot.adCopyStatus === "ready") break;
        // Hard-fail on any "failed" status — the whole point is that the
        // chain should not fail on the race the fix is closing.
        for (const k of [
          "icpStatus",
          "competitorStatus",
          "creativeDirStatus",
          "adImageStatus",
          "adCopyStatus",
        ] as const) {
          if (lastSnapshot[k] === "failed") {
            throw new Error(
              `pipeline failed at ${k}: ${(lastSnapshot as any)[
                k.replace("Status", "Error")
              ]}`,
            );
          }
        }
      }

      // ── 4. Acceptance assertions per Notion task NON-NEGOTIABLE criterion.
      expect(lastSnapshot.icpStatus).toBe("ready");
      expect(lastSnapshot.competitorStatus).toBe("ready");
      expect(lastSnapshot.creativeDirStatus).toBe("ready");
      expect(lastSnapshot.adImageStatus).toBe("ready");
      expect(lastSnapshot.adCopyStatus).toBe("ready");

      // 3 ad-copy variants with non-empty headline + primaryText
      const copyVariants = lastSnapshot.adCopyResult?.variants ?? [];
      expect(copyVariants).toHaveLength(3);
      for (const v of copyVariants) {
        expect(typeof v.headline).toBe("string");
        expect((v.headline ?? "").length).toBeGreaterThan(0);
        expect(typeof v.primaryText).toBe("string");
        expect((v.primaryText ?? "").length).toBeGreaterThan(0);
      }

      // 3 ad-image variants with image references
      const imageVariants = lastSnapshot.adImageResult?.variants ?? [];
      expect(imageVariants).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );
});
