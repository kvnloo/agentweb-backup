import { crmDb, orgDb } from '../db';
import { suppressLeadSideEffects } from '../../utils/sessionList';

/**
 * The lists a hot-lead call org can have leads in: its members' own lead lists, session lists left out (they never ring).
 * The discovery step shared by the stuck-record sweep and the press-2 due-retries sweep (org -> members -> lists); the caller
 * then reads each list's newest leads with `crmDb.findLeadsBySystemRecord`.
 */
export async function hotLeadCallOrgListIds(orgId: string): Promise<string[]> {
  const listIds = new Set<string>();
  for (const member of await orgDb.getOrgMembers(orgId)) {
    for (const list of await crmDb.getLeadListsByUserId(member.userId)) {
      if (!suppressLeadSideEffects(list)) listIds.add(list.listId);
    }
  }
  return [...listIds];
}
