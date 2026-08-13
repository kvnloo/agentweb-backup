import { orgDb, userDb, Organization } from './db';
import { recordAdminAudit } from './adminAuditLog';

const MAX_RESULTS = 100;
const MAX_ORGANIZATIONS = 1000;
const MAX_USER_LOOKUP_BATCH = 25;
const MAX_UNIQUE_USER_IDS_TO_LOOKUP = MAX_RESULTS;
const MAX_PENDING_REQUESTS_PER_ORGANIZATION = 1000;

export interface OrphanedOrgJoinReference {
  orgId: string;
  userId: string;
}

export interface OrphanedOrgJoinDiagnostic {
  organizationsScanned: number;
  pendingRequestsScanned: number;
  missingUserReferences: OrphanedOrgJoinReference[];
  truncated: boolean;
}

type Dependencies = {
  listOrganizations: () => Promise<Organization[]>;
  findUser: (userId: string) => Promise<unknown | null | undefined>;
  audit: (event: Record<string, unknown>) => void;
};

const defaultDependencies: Dependencies = {
  listOrganizations: () => orgDb.listAll(MAX_ORGANIZATIONS + 1),
  findUser: (userId) => userDb.getUserById(userId),
  audit: (event) => recordAdminAudit(event as any),
};

export async function findOrphanedOrgJoinRequests(
  dependencies: Partial<Dependencies> = {},
): Promise<OrphanedOrgJoinDiagnostic> {
  const deps = { ...defaultDependencies, ...dependencies };
  const orgs = await deps.listOrganizations();
  const organizations = orgs.slice(0, MAX_ORGANIZATIONS);
  const exceededOrganizationCap = orgs.length > MAX_ORGANIZATIONS;
  let pendingRequestsScanned = 0;
  let organizationsScanned = 0;
  const missingUserReferences: OrphanedOrgJoinReference[] = [];
  let truncated = exceededOrganizationCap;
  const requestedByUserId = new Map<string, OrphanedOrgJoinReference[]>();
  const userIdsToLookup: string[] = [];

  orgLoop: for (const organization of organizations) {
    organizationsScanned += 1;
    const requests = Array.isArray(organization.pendingDomainJoinRequests)
      ? organization.pendingDomainJoinRequests
      : [];
    const exceededPendingCap = requests.length > MAX_PENDING_REQUESTS_PER_ORGANIZATION;
    const requestWindow = requests.slice(0, MAX_PENDING_REQUESTS_PER_ORGANIZATION);

    for (const request of requestWindow) {
      if (!request || typeof request.userId !== 'string' || !request.userId.trim()) continue;

      const userId = request.userId.trim();
      pendingRequestsScanned += 1;
      const requestRef = { orgId: organization.orgId, userId };
      const existing = requestedByUserId.get(userId);
      if (existing) {
        existing.push(requestRef);
        continue;
      }

      if (requestedByUserId.size >= MAX_UNIQUE_USER_IDS_TO_LOOKUP) {
        truncated = true;
        break orgLoop;
      } else {
        requestedByUserId.set(userId, [requestRef]);
        userIdsToLookup.push(userId);
      }
    }

    if (exceededPendingCap) {
      truncated = true;
      break orgLoop;
    }
  }

  for (let i = 0; i < userIdsToLookup.length; i += MAX_USER_LOOKUP_BATCH) {
    if (missingUserReferences.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }

    const batch = userIdsToLookup.slice(i, i + MAX_USER_LOOKUP_BATCH);
    const lookupResults = await Promise.all(
      batch.map(async (userId) => ({
        userId,
        exists: Boolean(await deps.findUser(userId)),
      })),
    );

    for (const { userId, exists } of lookupResults) {
      if (exists) continue;
      for (const reference of requestedByUserId.get(userId) ?? []) {
        if (missingUserReferences.length < MAX_RESULTS) {
          missingUserReferences.push(reference);
        } else {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const result = {
    organizationsScanned,
    pendingRequestsScanned,
    missingUserReferences,
    truncated,
  };
  deps.audit({ action: 'inspect_orphaned_org_join_requests', ...result });
  return result;
}
