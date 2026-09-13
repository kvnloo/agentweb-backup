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
 * Never throws: an inactive/expired/unknown sandbox policy or an unloadable dataset makes this
 * return `undefined` too, so the caller falls back to the REAL fetch path for what is, at that
 * point, an unexpected state — the launch gate's own AC4 ("failure to verify is not permission
 * to proceed") still applies on top: a real fetch against a fictional dataset URL will fail to
 * resolve or find no pixel, and the gate blocks exactly as it should when nothing else is wrong.
 */
export async function buildSandboxFetchHtml(
  userId: string,
): Promise<((url: string, deadlineAt?: number) => Promise<string>) | undefined> {
  if (!isEvaluationUser(userId)) return undefined;
  try {
    const record = await requireActiveEvaluation(userId);
    if (!record.datasetId || record.datasetVersion === null || record.datasetVersion === undefined) return undefined;
    const dataset = await getSandboxDatasetStore().loadDataset(record.datasetId, record.datasetVersion);
    return async (url: string): Promise<string> => {
      const lander = dataset.landers.find((l) => l.url === url);
      return syntheticLanderHtml(lander);
    };
  } catch (error) {
    if (error instanceof EvaluationDenied) return undefined;
    console.error('[sandboxTrackingPreflight] failed to build sandbox fetchHtml, falling back to the real fetcher:', (error as Error).message);
    return undefined;
  }
}
