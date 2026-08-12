import { orgDb, userDb, Organization } from './db';
import { recordAdminAudit } from './adminAuditLog';

const MAX_RESULTS = 100;
const MAX_ORGANIZATIONS = 1000;

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
  listOrganizations: () => orgDb.listAll(MAX_ORGANIZATIONS),
  findUser: (userId) => userDb.getUserById(userId),
  audit: (event) => recordAdminAudit(event as any),
};

export async function findOrphanedOrgJoinRequests(
  dependencies: Partial<Dependencies> = {},
): Promise<OrphanedOrgJoinDiagnostic> {
  const deps = { ...defaultDependencies, ...dependencies };
  const organizations = await deps.listOrganizations();
  let pendingRequestsScanned = 0;
  const missingUserReferences: OrphanedOrgJoinReference[] = [];
  let truncated = false;

  for (const organization of organizations) {
    const requests = Array.isArray(organization.pendingDomainJoinRequests)
      ? organization.pendingDomainJoinRequests
      : [];
    for (const request of requests) {
      if (!request || typeof request.userId !== 'string' || !request.userId.trim()) continue;
      pendingRequestsScanned += 1;
      if (!(await deps.findUser(request.userId))) {
        if (missingUserReferences.length < MAX_RESULTS) {
          missingUserReferences.push({ orgId: organization.orgId, userId: request.userId });
        } else {
          truncated = true;
        }
      }
    }
  }

  const result = {
    organizationsScanned: organizations.length,
    pendingRequestsScanned,
    missingUserReferences,
    truncated,
  };
  deps.audit({ action: 'inspect_orphaned_org_join_requests', ...result });
  return result;
}
