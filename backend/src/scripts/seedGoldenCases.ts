/**
 * Build the ENG-2135 golden-set seed (case ids only) and optionally write it to the store.
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/seedGoldenCases.ts [--fp-catalogue <file>]
 *     [--target-agent N] [--target-creative N] [--target-account-health N] [--gated-creatives] [--ad-connected-accounts] [--write]
 *
 * Reads (read-only, projected scans — ids and flags only):
 *   AW-ChatSessions   sessionId, satisfactionScore.adminOverride, userId, createdAt, sessionType, messageCount
 *                     (the last four only decide `sampled_session` eligibility; no message bodies)
 *   AW-HumanEvalQueue candidateId, reviewType, reviewerSlackUserId, feedback (only each reply's slackUserId is kept)
 *   AW-Users          userId, subscription_status, isAdmin
 * (`Dev-` tables when NODE_ENV=development, as everywhere else.)
 *
 * `--fp-catalogue` is an off-repo JSON file mapping judge false-positive issues to the session
 * ids they name, plus the session turn behind each ENG-1312 replay fixture (goldenSetSeed.ts
 * FpCatalogue). It stays out of git because it holds production session ids.
 *
 * `--target-<surface>` overrides that surface's target case count (default 50/50/30, see
 * DEFAULT_SEED_TARGETS). Splits are a deterministic hash of the case id (~60% test / 40% dev,
 * `splitForCaseId`), not reassignable per case — the only way to grow a surface's *test* split
 * past the ENG-2136 validation minimum (MIN_VALIDATION_N = 30) is to raise its total target so
 * more cases get selected, some of which land in test.
 *
 * Prints counts only. Writes nothing unless `--write` is given, and then only to the table in
 * EVAL_GOLDEN_CASES_TABLE; with that unset it refuses and exits 1. Existing cases (and their
 * labels) are never overwritten — `store.createCase` only creates, so raising a target and
 * re-running is safe and idempotent: already-selected cases keep their id, split and any labels.
 */

import AWS from 'aws-sdk';
import { readFileSync } from 'fs';
import { paginatedScan } from '../utils/dynamoPagination';
import {
  AD_PLATFORMS,
  buildSeedCases,
  parseFpCatalogue,
  type FpCatalogue,
  type SeedCandidateRow,
  type SeedSessionRow,
  type SeedUserRow,
} from '../loops/eval/goldenSetSeed';
import type { EvalSurface } from '../loops/eval/evalRegistry';
import { goldenSetStoreFromEnv, GOLDEN_CASES_TABLE_ENV } from '../loops/eval/goldenSetStore';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

const TARGET_FLAGS: Record<string, EvalSurface> = {
  '--target-agent': 'agent',
  '--target-creative': 'creative',
  '--target-account-health': 'account_health',
};

export interface Args {
  fpCatalogue?: string;
  /** Add `gated_candidate` creative cases: candidates that carry a stored creative-gate result (ENG-2226). */
  gatedCreatives?: boolean;
  /** Take every account with an ad platform connected first (ENG-2135). */
  adConnectedAccounts?: boolean;
  write: boolean;
  targets: Partial<Record<EvalSurface, number>>;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { write: false, targets: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const surface = TARGET_FLAGS[flag];
    if (flag === '--write') args.write = true;
    else if (flag === '--gated-creatives') args.gatedCreatives = true;
    else if (flag === '--ad-connected-accounts') args.adConnectedAccounts = true;
    else if (flag === '--fp-catalogue') args.fpCatalogue = argv[++i];
    else if (surface) {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(raw)}`);
      args.targets[surface] = n;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

interface SessionItem {
  sessionId: string;
  satisfactionScore?: { adminOverride?: boolean };
  userId?: string;
  createdAt?: string;
  sessionType?: string;
  messageCount?: number;
}

interface CandidateItem {
  candidateId: string;
  reviewType?: string;
  reviewerSlackUserId?: string;
  feedback?: Array<{ slackUserId?: string }>;
  creativeGates?: { graderId?: string; notChecked?: string };
}

interface UserItem {
  userId?: string;
  subscription_status?: string;
  isAdmin?: boolean;
  /** Read only to learn which platforms are connected; the connection config (tokens) is never kept or printed. */
  connected_accounts?: Array<{ platform?: string }>;
}

async function loadInputs(client: AWS.DynamoDB.DocumentClient) {
  const sessions: SeedSessionRow[] = (
    await paginatedScan<SessionItem>(client, {
      TableName: `${TABLE_PREFIX}AW-ChatSessions`,
      ProjectionExpression: 'sessionId, satisfactionScore.adminOverride, userId, createdAt, sessionType, messageCount',
    })
  ).map((s) => ({
    sessionId: s.sessionId,
    adminOverride: s.satisfactionScore?.adminOverride === true,
    ...(s.userId ? { userId: s.userId } : {}),
    ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    ...(s.sessionType ? { sessionType: s.sessionType } : {}),
    ...(typeof s.messageCount === 'number' ? { messageCount: s.messageCount } : {}),
  }));

  const candidates: SeedCandidateRow[] = (
    await paginatedScan<CandidateItem>(client, {
      TableName: `${TABLE_PREFIX}AW-HumanEvalQueue`,
      ProjectionExpression: 'candidateId, reviewType, reviewerSlackUserId, feedback, creativeGates.graderId, creativeGates.notChecked',
    })
  ).map((c) => ({
    candidateId: c.candidateId,
    reviewType: c.reviewType ?? '',
    ...(c.reviewerSlackUserId ? { reviewerSlackUserId: c.reviewerSlackUserId } : {}),
    // Keep who replied, drop what they said.
    feedbackSlackUserIds: (c.feedback ?? []).flatMap((f) => (f.slackUserId ? [f.slackUserId] : [])),
    // A gate result that was actually evaluated; only its presence is read (no check detail).
    ...(c.creativeGates?.graderId && !c.creativeGates.notChecked ? { gated: true } : {}),
  }));

  const users: SeedUserRow[] = (
    await paginatedScan<UserItem>(client, {
      TableName: `${TABLE_PREFIX}AW-Users`,
      ProjectionExpression: 'userId, subscription_status, isAdmin, connected_accounts',
    })
  ).flatMap((u) =>
    u.userId
      ? [{
          userId: u.userId,
          subscriptionStatus: u.subscription_status,
          isAdmin: u.isAdmin === true,
          hasAdPlatform: (u.connected_accounts ?? []).some((a) => !!a?.platform && AD_PLATFORMS.has(a.platform)),
        }]
      : [],
  );

  return { sessions, candidates, users };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = goldenSetStoreFromEnv();
  if (args.write && !store.isProvisioned()) {
    console.error(`Refusing to write: ${GOLDEN_CASES_TABLE_ENV} is not set (golden-set store not provisioned, OPS-2 / ENG-2147).`);
    process.exit(1);
  }

  const fpCatalogue: FpCatalogue | undefined = args.fpCatalogue
    ? parseFpCatalogue(JSON.parse(readFileSync(args.fpCatalogue, 'utf8')))
    : undefined;
  const inputs = await loadInputs(new AWS.DynamoDB.DocumentClient());
  const result = buildSeedCases({
    ...inputs,
    ...(fpCatalogue ? { fpCatalogue } : {}),
    ...(Object.keys(args.targets).length ? { targets: args.targets } : {}),
    ...(args.gatedCreatives ? { gatedCreatives: true } : {}),
    ...(args.adConnectedAccounts ? { adConnectedAccounts: true } : {}),
    now: new Date(),
  });

  console.log(`Source rows: ${inputs.sessions.length} sessions, ${inputs.candidates.length} human-eval candidates, ${inputs.users.length} users`);
  for (const [surface, r] of Object.entries(result.report)) {
    const splits = result.cases.filter((c) => c.surface === surface);
    const test = splits.filter((c) => c.split === 'test').length;
    console.log(
      `${surface}: selected ${r.selected}/${r.target} (eligible ${r.eligible}; test ${test}, dev ${splits.length - test}) by source ${JSON.stringify(r.bySource)}`,
    );
  }
  if (fpCatalogue) console.log(`Catalogue ids with no unique session match: ${result.unresolvedCatalogueIds}`);
  if (result.unresolvedReplayFixtures.length) console.log(`Replay fixtures not linked: ${result.unresolvedReplayFixtures.join(', ')}`);
  console.log(`Replay-linked cases: ${result.cases.filter((c) => c.replay).length}`);

  if (!args.write) {
    console.log('Dry run: nothing written (pass --write to create the cases in the store).');
    return;
  }
  let created = 0;
  let existing = 0;
  for (const goldenCase of result.cases) {
    if ((await store.createCase(goldenCase)) === 'created') created++;
    else existing++;
  }
  console.log(`Wrote to ${store.tableName}: ${created} created, ${existing} already present (left unchanged).`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('seedGoldenCases failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
