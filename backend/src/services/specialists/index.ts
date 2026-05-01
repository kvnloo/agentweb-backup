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

export function registerAllEnrichmentSpecialists(): void {
  registerSpecialist(crunchbaseFundingRound);
  registerSpecialist(crunchbaseTotalFunding);
  registerSpecialist(crunchbaseHqCity);
}

export function clearAllEnrichmentSpecialists(): void {
  clearSpecialists();
}
