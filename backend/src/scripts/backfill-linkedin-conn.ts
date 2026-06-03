import { linkedInOutreachService as svc } from '../services/linkedInOutreachService';
import {
  upsertConnections,
  markFullSyncCompleted,
  normalizeLinkedInUrl,
  UnipileConnection,
} from '../services/unipileConnectionsDb';

const ACCOUNT = process.argv[2] || 'QBdKa04gQLKTuKYEJuOLtA';

// Self-contained mirror of syncConnectionsForAccount({fullSync:true}) that avoids
// importing the heavy cron module graph (openai/db/agentModeService) — keeps the
// one-off backfill script light enough to run under ts-node.
async function main() {
  console.log(`Backfilling connections for account ${ACCOUNT}...`);
  let cursor: string | undefined;
  let page = 0;
  let total = 0;
  do {
    const result: any = await svc.listConnections(ACCOUNT, cursor);
    const items: any[] = result?.items ?? [];
    if (items.length === 0) break;
    const toUpsert: UnipileConnection[] = items.map((item: any) => ({
      accountId: ACCOUNT,
      memberId: item.member_id || item.public_identifier,
      publicProfileUrl: normalizeLinkedInUrl(
        item.public_profile_url || `https://www.linkedin.com/in/${item.public_identifier}/`,
      ),
      memberUrn: item.member_urn ?? '',
      connectionUrn: item.connection_urn ?? '',
      firstName: item.first_name ?? '',
      lastName: item.last_name ?? '',
      headline: item.headline ?? '',
      connectedAt: item.created_at ?? 0,
      syncedAt: new Date().toISOString(),
    }));
    await upsertConnections(toUpsert);
    total += toUpsert.length;
    cursor = result?.cursor ?? undefined;
    page++;
  } while (cursor && page < 200);

  await markFullSyncCompleted(ACCOUNT);
  console.log(`Done. Upserted ${total} connections over ${page} pages and marked full-sync complete.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
