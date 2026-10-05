/**
 * ENG-2103 (F2) — `extractGeneratedImageFilenames`, promoted to a shared,
 * side-effect-free module.
 *
 * Originally `AgentModeService.prototype.extractGeneratedImageFilenames` (a
 * `public static` method with zero instance-state dependency). Found during
 * the work-plans cluster's extraction (`emma/impl/workPlans.ts`,
 * `setWorkPlanStatusAttempt` calls it) to ALSO be called from
 * `AgentModeService.buildMarketingContext` — a private method entirely
 * unrelated to work plans, not part of this or any extraction. Since it is
 * genuinely reused between an already-extracted module and code that stays on
 * the class, it gets the `shared/` promotion (same treatment as
 * `shared/contentReplacements.ts`/`shared/toolUsageMetering.ts`) rather than
 * moving wholesale into `workPlans.ts`, where `buildMarketingContext` could
 * not reach it without reintroducing a dependency on `agentModeService.ts`.
 *
 * `AgentModeService.extractGeneratedImageFilenames` is kept as a one-line
 * delegating static wrapper (not deleted, not changed in behavior) because
 * `agentModeService.buildWorkPlanContext.test.ts` calls it directly via
 * `AgentModeService.extractGeneratedImageFilenames(...)`.
 */
export function extractGeneratedImageFilenames(sessionHistory?: any[], sinceIso?: string): string[] {
  if (!Array.isArray(sessionHistory)) return [];
  const seen = new Set<string>();
  const filenames: string[] = [];
  for (const msg of sessionHistory) {
    if (!msg || msg.role !== 'system') continue;
    // Prefer the structured marker (newer messages); fall back to the legacy
    // content-string format so older / in-flight sessions are still detected.
    let filename: string | undefined;
    if (msg.metadata && msg.metadata.kind === 'image-generated' && typeof msg.metadata.imageFilename === 'string') {
      filename = msg.metadata.imageFilename.trim();
    } else if (typeof msg.content === 'string') {
      const match = msg.content.match(/^Image generated:\s*(.+?)\s*$/);
      if (match) filename = match[1].trim();
    }
    if (!filename || seen.has(filename)) continue;
    const timestamp = typeof msg.metadata?.timestamp === 'string' ? msg.metadata.timestamp : undefined;
    if (sinceIso && timestamp && timestamp < sinceIso) continue;
    seen.add(filename);
    filenames.push(filename);
  }
  return filenames;
}
