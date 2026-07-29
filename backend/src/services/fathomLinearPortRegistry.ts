/**
 * LinearPort registry seam for the Fathom → Linear router (ENG-259).
 *
 * The cloud webhook resolves its `LinearPort` here so the production adapter
 * (ENG-536) can plug in at composition time without the webhook knowing about
 * credentials or GraphQL. Until an adapter is registered, `getFathomLinearPort()`
 * returns null and the webhook reports the router as inactive — it never
 * half-runs against a missing boundary.
 */

import type { LinearPort } from './fathomLinearRouter';

let activePort: LinearPort | null = null;

/**
 * Register the production LinearPort. Fails loudly on double registration —
 * a silent port swap at runtime would make run reports unattributable.
 */
export function registerFathomLinearPort(port: LinearPort): void {
  if (activePort) {
    throw new Error(
      'A Fathom LinearPort is already registered — call _resetFathomLinearPort() first (tests only) or fix the double registration at the composition root.',
    );
  }
  activePort = port;
}

/** The registered port, or null while the production adapter (ENG-536) is pending. */
export function getFathomLinearPort(): LinearPort | null {
  return activePort;
}

/** Test seam — clear the registered port. */
export function _resetFathomLinearPort(): void {
  activePort = null;
}
