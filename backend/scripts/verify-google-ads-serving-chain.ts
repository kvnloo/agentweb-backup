/**
 * ENG-2523: read-only production readback of the ENG-1922 Google Ads Search serving chain.
 *
 * Usage:
 *   npx ts-node backend/scripts/verify-google-ads-serving-chain.ts \
 *     --user-id <agentweb user id> --customer-id <google ads id> [--campaign-id <id> ...]
 *
 * Prints one JSON object (verdict READY|DELIVERING|BLOCKED_BY_<entity>|UNVERIFIED, entity IDs,
 * TODAY impressions/cost). Exit 0 = DELIVERING/READY, 2 = any BLOCKED_BY_<entity> or UNVERIFIED, 1 = error.
 * Uses the user's stored credentials via googleAdsService; issues GAQL reads only — no
 * mutates, no DynamoDB writes beyond the service's normal OAuth token refresh.
 */
import { googleAdsService } from '../src/services/googleAdsService';
import { runServingChainCli } from '../src/services/googleAdsServingChainCli';

runServingChainCli(process.argv.slice(2), googleAdsService)
  .then(code => process.exit(code))
  .catch(() => process.exit(1));
