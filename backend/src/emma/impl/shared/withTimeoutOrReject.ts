/**
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — shared
 * promise/timeout race helper.
 *
 * Moved verbatim from a non-exported module-scope function in
 * `services/agentModeService.ts`. Promoted here (rather than moved into
 * `emma/impl/linkedin.ts` outright) because it has a real caller that stays
 * on the class forever: `AgentModeService.prototype.generateImage`'s
 * data-fabrication vision check (part of the `generateImage` →
 * `describeImage` → `callVisionLLMWithTimeout` → `callLLM` chain that is
 * never a candidate for extraction — see this series' design-decision list).
 * `resolveEmployersForSizeFilter` (moved to `emma/impl/linkedin.ts` this
 * round) is its other real caller. Both import it from here rather than one
 * defining it and the other reaching back into agentModeService.ts, which
 * would be a real (not just type-level) circular import in that direction.
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
