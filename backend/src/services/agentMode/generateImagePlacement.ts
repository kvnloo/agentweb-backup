/**
 * Pure request-shaping helper for `AgentModeService.generateImage` (ENG-2187).
 *
 * Kept out of the `agentModeService.ts` monolith per repo convention (see
 * `services/agentMode/metaImageSwapCheck.ts`, `dataFabricationGuard.ts`): pure decision logic
 * lives in a small `services/agentMode/*.ts` module; the request wiring itself stays in the
 * service. `isPlacementId` / `PlacementId` remain in `creativePlacementSpecs.ts` (they are the
 * placement table's own validators, used well beyond this one call site).
 */
import { isPlacementId, type PlacementId } from '../creativePlacementSpecs';

/**
 * The `placement` field to spread into an image-generation request: present only when the
 * caller's `placement` argument is a recognized `PlacementId`. An unrecognized value (a typo, or
 * a stale client) is dropped rather than sent on ungated — `generate_image`'s tool schema
 * declares an enum, but nothing stops a caller from passing an arbitrary string outside it.
 */
export function declaredPlacementField(placement: string | undefined): { placement: PlacementId } | Record<string, never> {
  return isPlacementId(placement) ? { placement } : {};
}
