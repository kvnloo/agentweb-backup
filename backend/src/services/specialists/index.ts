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
import { enrichSoEmailFinderSpecialist } from './enrichSoEmailFinder';
import { enrichSoReverseLookupSpecialists } from './enrichSoReverseLookup';

export function registerAllEnrichmentSpecialists(): void {
  registerSpecialist(crunchbaseFundingRound);
  registerSpecialist(crunchbaseTotalFunding);
  registerSpecialist(crunchbaseHqCity);
  registerSpecialist(enrichSoEmailFinderSpecialist);
  for (const spec of enrichSoReverseLookupSpecialists) {
    registerSpecialist(spec);
  }
}

export function clearAllEnrichmentSpecialists(): void {
  clearSpecialists();
}
