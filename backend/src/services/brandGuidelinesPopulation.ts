import { userDb, orgDb } from './db';
import { emptyBrandFields, fillEmptyBrandGuidelines } from '../utils/brandGuidelines';

/** Resolve the same org/owner precedence as the brand page. Never use a member's
 * personal company information as the organization's brand source. */
export async function planBrandGuidelinesPopulation(userId: string) {
  let user = await userDb.getUserById(userId);
  if (!user) throw new Error(`Brand population: user ${userId} missing`);
  user = await userDb.getUserByEmailConsistent(user.email);
  if (!user || user.userId !== userId) throw new Error(`Brand population: user ${userId} missing`);
  const org = user.orgId ? await orgDb.getOrgById(user.orgId) : undefined;
  if (user.orgId && !org) throw new Error(`Brand population: org ${user.orgId} missing`);
  if (org && org.ownerUserId !== user.userId) {
    const owner = await userDb.getUserById(org.ownerUserId);
    if (!owner) throw new Error(`Brand population: owner ${org.ownerUserId} missing`);
    user = await userDb.getUserByEmailConsistent(owner.email);
    if (!user || user.userId !== org.ownerUserId) throw new Error(`Brand population: owner ${org.ownerUserId} missing`);
  }
  // Keep writing the owner fallback until the org has its own brand. Creating
  // a partial org copy would permanently mask later owner attachments/edits.
  const target = org?.brandGuidelines ? org : user;
  const existing = target.brandGuidelines;
  if (existing && (typeof existing !== 'object' || Array.isArray(existing) ||
      (existing.brandData != null && (typeof existing.brandData !== 'object' || Array.isArray(existing.brandData))))) {
    throw new Error('Brand population: malformed existing brand; manual review required');
  }
  const strategy = org?.marketStrategy || user.marketStrategy;
  const { guidelines, filledFields } = fillEmptyBrandGuidelines(existing, strategy, user);
  return {
    userId: user.userId, email: user.email,
    orgId: target === org ? org!.orgId : undefined,
    existing, guidelines, filledFields, emptyFields: emptyBrandFields(existing),
  };
}

export async function applyBrandGuidelinesPopulation(plan: Awaited<ReturnType<typeof planBrandGuidelinesPopulation>>) {
  if (!plan.filledFields.length) return;
  // Compare the entire snapshot, not just the timestamp: another writer can
  // save within the same millisecond. A concurrent edit fails closed.
  const condition = {
    expression: 'attribute_exists(#identity) AND ' +
      (plan.existing === undefined ? 'attribute_not_exists(#brand)' : '#brand = :before'),
    names: { '#brand': 'brandGuidelines', '#identity': plan.orgId ? 'orgId' : 'email' },
    values: plan.existing === undefined ? {} : { ':before': plan.existing },
  };
  const update = { brandGuidelines: plan.guidelines } as any;
  if (plan.orgId) await orgDb.updateOrg(plan.orgId, update, { condition });
  else await userDb.updateUser(plan.userId, update, { condition });
}

/** Setup has already saved its primary result; surface projection errors without
 * reporting that the original save failed (or retrying over a concurrent edit). */
export async function populateEmptyBrandGuidelines(userId: string): Promise<void> {
  try {
    await applyBrandGuidelinesPopulation(await planBrandGuidelinesPopulation(userId));
  } catch (error) {
    console.error('[brandGuidelines] fill-only population failed', { userId, error });
  }
}
