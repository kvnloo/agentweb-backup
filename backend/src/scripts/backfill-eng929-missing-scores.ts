/**
 * ENG-929 remediation — score the specific completed sessions the coverage bug left null.
 *
 * The code fix (sessionScoringService.ts / scoreBackfill.ts, this ticket) only changes
 * behavior for scoring attempted from now on. It does not retroactively touch rows a
 * prior, buggy sync=true call already gave up on. Three sessions from the
 * 2026-08-05T00:00:00Z -> 2026-08-06T23:59:59Z window are known to still be stuck (checked
 * against production 2026-08-31): the flat 20s scoring timeout raced a thinking-model judge
 * on their transcripts and lost, and nothing ever re-attempts a session once its home
 * day's report window has passed. This script is the one-time repair for exactly those
 * three:
 *   - 782374b3-1d9b-43d7-b37f-5f54c69e92a4 (Every.io Weekly Meta Creative Fatigue Report)
 *   - 87b7e071-eb8b-4951-ab76-a80b9f3cd31a (Kevin — Daily LinkedIn Post, 69 msgs, $9.45)
 *   - 49e9cf59-470b-4283-87e2-145c1e69f8ee (Daily ICP Lead Finder — Every.io)
 * (The window's 4th flagged session, 9690df0d-..., already self-resolved via a later
 * routine run and does not need repair. The 4 sessions flagged as "in-flight" at read
 * time were legitimately mid-run, not bugged, and have since scored normally too.)
 *
 * Verified live against production data before writing this script: scoreSession() run
 * directly against 87b7e071's real transcript (this branch's fixed code, real LLM call)
 * completed in 6.86s and returned a full 5/5/5 score — confirming the fix actually
 * resolves this session, not just theoretically.
 *
 * ── What it changes ────────────────────────────────────────────────────────
 * Calls the SAME backfillSessionScores() function get_chat_history(sync=true) already
 * calls in production every day, restricted to exactly the 3 session IDs above. Writes
 * satisfactionScore (and judgeScores, if judges are configured) only on a session that is
 * still unscored — attemptSessionScore's own already-scored/admin-override guards apply
 * unchanged, so a second run of this script is a no-op. It never deletes, never touches
 * any other session, and never changes any field but the score ones this ticket's fix
 * already writes through the normal application path.
 *
 * NOTE (CLAUDE.md data-plane gate): this writes production data and needs Harsha's
 * approval before anyone runs it with --apply. It must not run until the ENG-929 fix
 * (this file's own PR) is deployed to production — the whole point is to exercise the
 * FIXED code path, and run against the OLD code it would just fail exactly as before.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng929-missing-scores.ts            # DRY RUN
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng929-missing-scores.ts --apply     # write
 */
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import "../config/aws";
import { chatbotDb } from "../services/chatbotService";
import { settingsService } from "../services/settingsService";
import { backfillSessionScores } from "../services/scoreBackfill";
import { ScoringJudge } from "../services/sessionScoringService";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const APPLY = process.argv.includes("--apply");

const SESSION_IDS = [
  "782374b3-1d9b-43d7-b37f-5f54c69e92a4",
  "87b7e071-eb8b-4951-ab76-a80b9f3cd31a",
  "49e9cf59-470b-4283-87e2-145c1e69f8ee",
];

async function main() {
  console.log("ENG-929 missing-score backfill", {
    region: process.env.AWS_REGION,
    nodeEnv: process.env.NODE_ENV || "production",
    mode: APPLY ? "APPLY (will write)" : "DRY RUN (no writes — pass --apply to write)",
    sessionIds: SESSION_IDS,
  });

  const sessions = [];
  for (const sessionId of SESSION_IDS) {
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      console.log(`  ${sessionId}: NOT FOUND — skipping`);
      continue;
    }
    if (session.satisfactionScore) {
      console.log(
        `  ${sessionId}: already has a satisfactionScore (evaluatedAt=${session.satisfactionScore.evaluatedAt}) — leaving as-is, backfillSessionScores will skip it`
      );
    }
    sessions.push(session);
  }

  if (sessions.length === 0) {
    console.log("\nNo sessions to process. Done.");
    return;
  }

  let judges: ScoringJudge[] = [];
  try {
    const setting = await settingsService.getSetting("scoring-judges");
    if (setting?.settingValue) {
      judges = JSON.parse(setting.settingValue);
    }
  } catch (error) {
    console.error("Error loading scoring judges:", error);
  }
  console.log(`Loaded ${judges.length} configured judge(s).`);

  if (!APPLY) {
    console.log(
      "\n[DRY RUN] Would call backfillSessionScores() for the sessions above. Re-run with --apply to write."
    );
    return;
  }

  const result = await backfillSessionScores(sessions as any, judges, {
    onError: (session, error) =>
      console.error(`Error scoring session ${(session as any).sessionId}:`, error),
  });

  console.log("\nOutcomes:");
  for (const outcome of result.outcomes) {
    console.log(`  ${outcome.sessionId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
  }
  console.log(
    `\nDone. scored=${result.scored} skipped=${result.skipped} timedOut=${result.timedOut}`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
