/**
 * Centralized specialist registration.
 *
 * Called explicitly at server boot (server.ts) so tests don't unintentionally
 * pick up specialists. Tests that exercise the specialist registry should
 * register specifically.
 */

import { registerSpecialist, clearSpecialists } from '../enrichmentSpecialists';
import {
  crunchbaseFundingRound,
  crunchbaseTotalFunding,
  crunchbaseHqCity,
} from './crunchbaseSpecialist';
import {
  waterfallEmailFinderSpecialist,
  waterfallReverseLookupSpecialists,
} from '../enrichmentWaterfall';
import { apolloEmploymentHistorySpecialist } from './apolloEmploymentHistory';
import { apolloOrgEnrichmentSpecialists } from './apolloOrgEnrichment';

export function registerAllEnrichmentSpecialists(): void {
  registerSpecialist(crunchbaseFundingRound);
  registerSpecialist(crunchbaseTotalFunding);
  registerSpecialist(crunchbaseHqCity);
  // Email finder + 12 reverse-lookup fields go through the waterfall so leads
  // with a LinkedIn URL try Apollo first (richest match) and email-only leads
  // try enrich.so first (cheaper). The original enrich.so specialists remain
  // exported (for direct test imports) but are no longer registered globally.
  registerSpecialist(waterfallEmailFinderSpecialist);
  for (const spec of waterfallReverseLookupSpecialists) {
    registerSpecialist(spec);
  }
  // Apollo-only fields — no waterfall, single provider.
  registerSpecialist(apolloEmploymentHistorySpecialist);
  for (const spec of apolloOrgEnrichmentSpecialists) {
    registerSpecialist(spec);
  }
}

export function clearAllEnrichmentSpecialists(): void {
  clearSpecialists();
}
