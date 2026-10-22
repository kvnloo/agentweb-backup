/**
 * ENG-669 (#3607 follow-up 6): the engine's model provenance bookkeeping on a session's work plan (`planAuthor`,
 * `launchModelSource`, `planDefaultModelSource`, each step's `modelSource`) is for AgentWeb and admins only. Every
 * non-admin read of a session or plan drops it; the customer portal reads none of it (it reads the step `model`s,
 * `templatePlanId` and the session's own `llmModelSource`, which stay).
 */

/** The work plan without its provenance bookkeeping. Returns a copy; the stored plan is untouched. */
export function redactWorkPlanProvenance<T>(workPlan: T): T {
  if (!workPlan || typeof workPlan !== 'object') return workPlan;
  const { planAuthor: _pa, launchModelSource: _ls, planDefaultModelSource: _ps, ...rest } = workPlan as Record<string, unknown>;
  if (!Array.isArray(rest.steps)) return rest as T;
  return {
    ...rest,
    steps: rest.steps.map((s: unknown) => (s && typeof s === 'object' && 'modelSource' in s
      ? (({ modelSource: _ms, ...step }) => step)(s as Record<string, unknown>)
      : s)),
  } as T;
}

/**
 * A session as a non-admin reads it: its work plan without provenance bookkeeping (see above). An admin (or an admin
 * acting as a delegate) reads it whole. Returns a shallow copy when anything is dropped; the stored session is untouched.
 */
export function withoutWorkPlanProvenance<T>(session: T, viewerIsAdmin: boolean): T {
  if (viewerIsAdmin || !session || typeof session !== 'object') return session;
  const workPlan = (session as { workPlan?: unknown }).workPlan;
  if (!workPlan || typeof workPlan !== 'object') return session;
  return { ...session, workPlan: redactWorkPlanProvenance(workPlan) };
}
