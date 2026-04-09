/**
 * One-time backfill script: generate AI thumbnails for all existing workplans
 * that don't already have one.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/backfill-workplan-thumbnails.ts
 *   NODE_ENV=development npx ts-node src/scripts/backfill-workplan-thumbnails.ts
 *
 * Features:
 *   - Processes all workplans without a thumbnail
 *   - Max 5 concurrent generation requests
 *   - 3 attempts with exponential backoff per plan
 *   - Logs per-plan results and prints a summary at the end
 */

import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { workPlanService, WorkPlan } from '../services/workPlanService';
import { WorkPlanThumbnailService } from '../services/workPlanThumbnailService';

const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

interface PlanResult {
  planId: string;
  title: string;
  status: 'success' | 'skipped' | 'failed';
  thumbnailUrl?: string;
  error?: string;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithRetry(
  service: WorkPlanThumbnailService,
  plan: WorkPlan,
  attempt = 1,
): Promise<WorkPlan> {
  try {
    return await service.generateAIThumbnail(plan);
  } catch (err: any) {
    if (attempt >= MAX_RETRIES) throw err;
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.warn(
      `  ⚠️  Attempt ${attempt}/${MAX_RETRIES} failed for "${plan.title}". Retrying in ${delay}ms...`,
    );
    await sleep(delay);
    return generateWithRetry(service, plan, attempt + 1);
  }
}

async function processChunk(
  service: WorkPlanThumbnailService,
  plans: WorkPlan[],
): Promise<PlanResult[]> {
  return Promise.all(
    plans.map(async (plan): Promise<PlanResult> => {
      try {
        console.log(`  ⏳ Generating thumbnail for "${plan.title}" (${plan.planId})...`);
        const updated = await generateWithRetry(service, plan);

        if (updated.thumbnail_source === 'ai' && updated.thumbnail_url) {
          console.log(`  ✅ Success: "${plan.title}" → ${updated.thumbnail_url}`);
          return {
            planId: plan.planId,
            title: plan.title,
            status: 'success',
            thumbnailUrl: updated.thumbnail_url,
          };
        }

        console.warn(`  ⚠️  Generation returned no URL for "${plan.title}"`);
        return {
          planId: plan.planId,
          title: plan.title,
          status: 'failed',
          error: 'Generation returned no thumbnail URL',
        };
      } catch (err: any) {
        console.error(`  ❌ Failed: "${plan.title}" — ${err.message}`);
        return {
          planId: plan.planId,
          title: plan.title,
          status: 'failed',
          error: err.message,
        };
      }
    }),
  );
}

async function main() {
  console.log(`\n🖼️  Workplan Thumbnail Backfill`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Concurrency: ${MAX_CONCURRENCY}, Max retries: ${MAX_RETRIES}\n`);

  const allPlans = await workPlanService.getAllWorkPlans();
  console.log(`📋 Found ${allPlans.length} total workplans`);

  const plansNeedingThumbnail = allPlans.filter(
    (p) => !p.thumbnail_url || p.thumbnail_source === 'none',
  );
  const skippedPlans = allPlans.filter((p) => p.thumbnail_url && p.thumbnail_source !== 'none');

  console.log(`   ${skippedPlans.length} already have thumbnails (skipped)`);
  console.log(`   ${plansNeedingThumbnail.length} need thumbnails\n`);

  if (plansNeedingThumbnail.length === 0) {
    console.log('✅ All workplans already have thumbnails. Nothing to do.\n');
    return;
  }

  const thumbnailService = new WorkPlanThumbnailService();
  const results: PlanResult[] = [];

  // Mark skipped plans
  for (const plan of skippedPlans) {
    results.push({ planId: plan.planId, title: plan.title, status: 'skipped' });
  }

  // Process in chunks of MAX_CONCURRENCY
  for (let i = 0; i < plansNeedingThumbnail.length; i += MAX_CONCURRENCY) {
    const chunk = plansNeedingThumbnail.slice(i, i + MAX_CONCURRENCY);
    console.log(
      `Processing chunk ${Math.floor(i / MAX_CONCURRENCY) + 1}/${Math.ceil(plansNeedingThumbnail.length / MAX_CONCURRENCY)} (${chunk.length} plans)...`,
    );
    const chunkResults = await processChunk(thumbnailService, chunk);
    results.push(...chunkResults);
  }

  // Summary
  const succeeded = results.filter((r) => r.status === 'success');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log('\n─────────────────────────────────────────');
  console.log(`📊 Backfill Summary`);
  console.log(`   ✅ Succeeded: ${succeeded.length}`);
  console.log(`   ⏭️  Skipped:   ${skipped.length}`);
  console.log(`   ❌ Failed:    ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n❌ Failed plans (trigger regeneration manually from Partner Portal):');
    for (const f of failed) {
      console.log(`   - ${f.planId}  "${f.title}"  Error: ${f.error}`);
    }
    process.exit(1);
  }

  console.log('\n✅ Backfill complete!\n');
}

main().catch((err) => {
  console.error('Fatal error in backfill script:', err);
  process.exit(1);
});
