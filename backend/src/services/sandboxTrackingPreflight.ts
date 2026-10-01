/**
 * Sandbox-aware destination check for the Meta launch gate (ENG-1909).
 *
 * The launch gate (`runMetaTrackingGate`) stays LIVE for a sandbox account — a candidate who
 * points an ad at an unmeasured destination is still blocked exactly as a real customer would
 * be, and that IS signal, not a bug to route around (per the sandbox design doc §5). What
 * changes is how the destination's HTML is obtained: the real `defaultFetchHtml` in
 * `metaTrackingPreflight.ts` makes a real outbound fetch, but a sandbox account's ads point at
 * fictional/example.invalid destinations that either don't resolve or, if a candidate crafts a
 * real-looking URL, would otherwise cause an unwanted real HTTP request to an arbitrary third
 * party. Answering from the account's own frozen dataset avoids both.
 */
import { isEvaluationUser, requireActiveEvaluation, EvaluationDenied } from './evaluationPolicy';
import { getSandboxDatasetStore } from './sandbox/sandboxDatasetStore';
import type { SandboxLander } from './sandbox/types';

/**
 * Synthetic HTML embedding a real `fbq('init', '<id>')` call per declared pixel id — the exact
 * pattern `detectMetaPixels` (metaTrackingPreflight.ts) scans executable `<script>` blocks for.
 * A lander with no declared pixel ids gets HTML with none, so `detectMetaPixels` correctly
 * finds nothing and the gate blocks it exactly as it would a genuinely untracked page.
 */
function syntheticLanderHtml(lander: SandboxLander | undefined): string {
  const pixelIds = lander?.pixelIds ?? [];
  const initCalls = pixelIds.map((id) => `fbq('init', '${id}');`).join('\n    ');
  return `<!DOCTYPE html><html><head><title>Sandbox lander</title></head><body>
  <script>
    ${initCalls}
  </script>
  </body></html>`;
}

/**
 * Builds a `fetchHtml` override for `MetaGateDeps`/`runMetaTrackingGate`, or `undefined` when
 * `userId` is not a sandbox principal — callers should pass that straight through as the
 * `fetchHtml` field so a real account's gate call is unaffected (a `deps.fetchHtml` of
 * `undefined` falls back to the real fetcher via `??`, per `MetaPreflightDeps`).
 *
 * Never falls back to the real fetcher for a sandbox principal, and never throws. Once
 * `isEvaluationUser(userId)` is true, every exit is a synthetic-HTML function — an inactive/
 * expired/unknown policy, a dataset load failure, or any other unexpected error all resolve to
 * the same no-pixel synthetic response (ENG-1909, CodeRabbit) rather than `undefined`, which
 * would otherwise let `preflightMetaTrackingGate`'s `deps.fetchHtml ?? defaultFetchHtml` make a
 * real outbound request to whatever destination URL the sandbox candidate configured. The
 * launch gate's own AC4 ("failure to verify is not permission to proceed") means a no-pixel
 * response still blocks correctly — it just does so without ever touching the real network.
 */
export async function buildSandboxFetchHtml(
  userId: string,
): Promise<((url: string, deadlineAt?: number) => Promise<string>) | undefined> {
  if (!isEvaluationUser(userId)) return undefined;
  const blocked = async (): Promise<string> => syntheticLanderHtml(undefined);
  try {
    const record = await requireActiveEvaluation(userId);
    if (!record.datasetId || record.datasetVersion === null || record.datasetVersion === undefined) return blocked;
    const dataset = await getSandboxDatasetStore().loadDataset(record.datasetId, record.datasetVersion);
    return async (url: string): Promise<string> => {
      const lander = dataset.landers.find((l) => l.url === url);
      return syntheticLanderHtml(lander);
    };
  } catch (error) {
    if (!(error instanceof EvaluationDenied)) {
      console.error('[sandboxTrackingPreflight] failed to build sandbox fetchHtml, blocking instead of falling back to the real fetcher:', (error as Error).message);
    }
    return blocked;
  }
}
