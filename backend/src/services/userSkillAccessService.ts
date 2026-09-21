import { isFeatureEffectivelyEnabled } from './orgShareService';

export async function resolveUserSkillAccess(userId: string) {
  try {
    const { userDb, orgDb } = await import('./db');
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return { user };
    const org = await orgDb.getOrgById(user.orgId);
    return {
      user,
      sharedOrgId: isFeatureEffectivelyEnabled({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, 'skills')
        ? user.orgId : undefined,
    };
  } catch {
    return { user: undefined };
  }
}
