/**
 * ENG-613 (PR3) — de-hardcode + harden the "Inbound Website Lead Engagement Logic"
 * skill (prod `92ed7c80`). Blindspot 3: it hardcodes AgentWeb's landing-page list
 * names + ICP verticals ("HealthTech/FinTech highest priority") and wires 17 tools
 * (incl. linkedin_outreach, enrich_leads_execute) with no stop conditions — so an
 * org member running it applies AgentWeb's ICP to their leads.
 *
 * This script is the reproducible, reviewable record of the change:
 *   - replaces the prompt with the de-hardcoded base in `inboundWebsite.dehardened.md`
 *     (all org-specific facts loaded at runtime via read_market_strategy /
 *     read_brand_guidelines / get_lead_lists for the REQUESTING org), and
 *   - appends the canonical CONTEXT FRESHNESS + SAFETY & VOLUME LIMITS + FAILURE
 *     HANDLING blocks via the ENG-608 framework (planSkillChange).
 *
 * DRY-RUN by default (plan + leak scan, no write). Flags:
 *   --apply        write the hardened row to DEV (stages prod->dev first)
 *   --verify-only  read the current DEV row and report markers/leaks
 *
 *   NODE_ENV=development npx ts-node src/scripts/dehardenInboundWebsite.ts
 *   NODE_ENV=development npx ts-node src/scripts/dehardenInboundWebsite.ts --apply
 *
 * Prod promotion is done separately via the admin API (field-preserving PUT),
 * after review — never from this script.
 */
import * as fs from "fs";
import * as path from "path";
import AWS from "aws-sdk";
import { skillService } from "../services/skillService";
import { planSkillChange } from "../services/skillHardening/applyHardening";

const PROD_PREFIX = "92ed7c80";
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, "inboundWebsite.dehardened.md"), "utf8");

// Strings that MUST NOT survive the de-hardcode (AgentWeb-specific facts).
const BANNED = [
  "HealthTech", "FinTech", "Verticalized AI Marketing", "Emma Partner Network",
  "AI Readiness Roadmap", "2026 State of AI Marketing", "Brandon Nader", "ThinkingAI",
  "harsha@agentweb.pro", "ruiw@agentweb.pro", "ftan@agentweb.pro",
  "urn:li:activity:7470684807505833985", "for AgentWeb",
];
const MARKERS = ["## CONTEXT FRESHNESS", "## SAFETY & VOLUME LIMITS", "## FAILURE HANDLING"];

function report(label: string, prompt: string, tools: string[]) {
  console.log(`\n--- ${label} ---`);
  console.log(`promptLen=${prompt.length}  toolCount=${tools.length}`);
  for (const m of MARKERS) console.log(`  marker ${m}: ${prompt.includes(m)}`);
  const leaks = BANNED.filter((b) => prompt.includes(b));
  console.log(`  hardcoded leaks: ${leaks.length ? leaks.join(", ") : "NONE"}`);
  return leaks.length === 0 && MARKERS.every((m) => prompt.includes(m));
}

// Resolve against PROD (AW-Skills) directly — the row may not be staged to dev yet
// on a fresh environment, so a dev-only lookup would wrongly throw before syncSkill.
async function resolveProdId(): Promise<string> {
  const ddb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  let ExclusiveStartKey: any;
  do {
    const r = await ddb
      .scan({ TableName: "AW-Skills", ProjectionExpression: "skillId", ExclusiveStartKey })
      .promise();
    const hit = (r.Items || []).find((i: any) => (i.skillId || "").startsWith(PROD_PREFIX));
    if (hit) return hit.skillId as string;
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  throw new Error(`prod skill ${PROD_PREFIX} not found in AW-Skills`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const verifyOnly = process.argv.includes("--verify-only");
  const skillId = await resolveProdId();
  console.log(`Inbound Website Lead Engagement Logic: ${skillId}`);

  if (verifyOnly) {
    const cur = await skillService.getSkill(skillId);
    if (!cur) throw new Error("skill not found in dev");
    const ok = report("DEV current", cur.systemPrompt || "", cur.toolNames || []);
    if (!ok) throw new Error("DEV prompt failed verification (leaks or missing markers)");
    return;
  }

  // Stage prod -> dev so we plan against the live row, then swap in the base.
  await skillService.syncSkill(skillId, "prod-to-dev");
  const dev = await skillService.getSkill(skillId);
  if (!dev) throw new Error("staging to dev failed");
  const plan = planSkillChange({ ...dev, systemPrompt: BASE_PROMPT }, {
    skillId, blocks: ["context", "safety", "failure"],
  });
  console.log(`plan: appended=[${plan.appended.join(",")}] +tools=[${plan.addedTools.join(",")}]`);
  const ok = report(apply ? "AFTER (planned)" : "DRY-RUN (planned)", plan.skill.systemPrompt || "", plan.skill.toolNames || []);
  if (!ok) throw new Error("planned prompt failed verification (leaks or missing markers) — refusing");

  if (apply) {
    // Guard against a stale read-modify-write: re-read immediately before the put
    // and bail if the row changed since we planned against it, so a concurrent edit
    // is never silently clobbered (mirrors hardenSkills.ts).
    const current = await skillService.getSkill(skillId);
    if (!current || current.updatedAt !== dev.updatedAt) {
      throw new Error("dev row changed since read (updatedAt) — aborting to avoid clobbering a concurrent edit");
    }
    await skillService.updateSkill(plan.skill);
    const after = await skillService.getSkill(skillId);
    report("DEV after write", after!.systemPrompt || "", after!.toolNames || []);
    console.log("\napplied to DEV ✅  (promote to prod separately via admin API after review)");
  } else {
    console.log("\n(dry-run — pass --apply to write DEV)");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
