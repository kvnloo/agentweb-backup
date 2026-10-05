/**
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — shared
 * promise/timeout race helper.
 *
 * Moved verbatim from a non-exported module-scope function in
 * `services/agentModeService.ts`. Promoted here (rather than moved into
 * `emma/impl/linkedin.ts` outright) because it originally had two real
 * callers that lived in two different places: `resolveEmployersForSizeFilter`
 * (moved to `emma/impl/linkedin.ts`) and `generateImage`'s data-fabrication
 * vision check (part of the `generateImage` → `describeImage` →
 * `callVisionLLMWithTimeout` → `callLLM` chain). Both import it from here
 * rather than one defining it and the other reaching back into the owning
 * module, which would be a real (not just type-level) circular import.
 *
 * ENG-2103 (F2 design-decision-list follow-up, later round): `generateImage`
 * (along with `describeImage`/`callVisionLLMWithTimeout`) has since moved
 * into `emma/impl/mediaVideo.ts` — this module stays the shared home for
 * `withTimeoutOrReject` regardless, since it's a generic promise/timeout race
 * helper with no dependency on either caller's module.
 */
export function withTimeoutOrReject<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`${label} timed out after ${ms}ms`);
      err.isTimeout = true;
      err.classification = 'TIMEOUT_ERROR';
      reject(err);
    }, ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
