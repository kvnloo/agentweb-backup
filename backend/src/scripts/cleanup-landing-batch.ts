/**
 * One-off batch cleanup (2026-06-13) — heal 7 landing sites to clean
 * agentwebforms.com subdomains (reassigning owner where asked) and soft-archive
 * 7 dumped sites. Credit-free: Vercel domains API + DynamoDB only, no rebuilds.
 * Soft-archive is reversible (flip `archived`); subdomain assignment is additive.
 *
 *   npx ts-node src/scripts/cleanup-landing-batch.ts            # dry-run
 *   npx ts-node src/scripts/cleanup-landing-batch.ts --apply
 */
import AWS from "aws-sdk";
import { addSubdomain } from "../services/customDomainService";

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const TABLE = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-LandingPages`;

// owner userIds
const PMPS = "1359ace4-0565-4018-9926-f51efdcf4c47"; // info@pmps.ai

const HEAL: { id: string; projectId: string; owner: string; subdomain: string }[] = [
  { id: "9e83b15e-d188-4b2b-9a76-44305ab34d96", projectId: "prj_KGnTpOQtOJ1I1zYl302YRgS8itLj", owner: "9fde4157-e73f-4f0e-9d3a-ac8fe97b35ec", subdomain: "open-future-forum" },        // Murray (already)
  { id: "13059545-4d69-4b07-9430-ac2681b819e3", projectId: "prj_kuenTc95OaULxFUaZrMToG6lnOVI", owner: "94d9a694-ccfb-43c4-8d98-b8d31eeb494f", subdomain: "insightful-tech" },          // Jerry (already)
  { id: "634b1867-e5c7-457e-9157-c0137a22edf4", projectId: "prj_lhYUYQXok1bplD1xHvTMhNrD9ST9", owner: PMPS, subdomain: "incentivpay-book-a-demo" },                                   // already info@pmps
  { id: "1c0c38fa-f0e4-4a8d-85cc-347fe6ba8f66", projectId: "prj_RkhpSE32HAFC2sPSczsgVK2T63RG", owner: PMPS, subdomain: "incentivpay-beverages" },                                     // ning -> info@pmps
  { id: "7d3e1b28-0587-49f8-b3ae-a1720d77aa20", projectId: "prj_tvoKW6uwvKWx7Cz93FFK1GXwfhNw", owner: PMPS, subdomain: "incentivpay-game-day" },                                      // ning -> info@pmps
  { id: "4451c554-7f77-43c2-839b-d8ee52d5b39b", projectId: "prj_r9MOyWpyvOcaIZMALkA9q76MCyPZ", owner: PMPS, subdomain: "incentivpay-sports-apparel" },                                // ning -> info@pmps
  { id: "362d359e-d210-4073-b9ef-1b80238a8145", projectId: "prj_SCaZnCDTowI7H0xLdm7uDL8YF4ei", owner: "8b01fed0-...", subdomain: "seamate-global-ai-tech-community" },                // Seamate (keep owner -> filled from record)
];

const DUMP_IDS = [
  "98ebf359-fa3b-411d-9c3f-0fc69a9dafee", // 5Star
  "c7e0cdc9-d3df-400d-a886-ac9483131196", // Cofounder Repair
  "f9e64bb6-47c6-4101-bd7d-8cf03fdd7ef6", // Female Founders
  "c900d6e8-7db0-448c-9684-49c85fc58214", // Goalden Hour
  "45f291f3-0cfc-4435-8aa3-b2f43fd7961d", // Phoenix
  "ee98a305-1398-488d-a5f8-7a3095295dd8", // TerraLink
  "3f200cb9-5bfa-467c-83c4-eb9be1275420", // Vivian Health
];

const repoOf = (i: any): string =>
  ((i.githubRepoUrl || "").match(/github\.com\/[^/]+\/([^/]+)/)?.[1]) || `__no_repo_${i.id}`;

async function scanAll(): Promise<any[]> {
  const out: any[] = [];
  let lek: any;
  do {
    const r = await dynamodb.scan({ TableName: TABLE, ExclusiveStartKey: lek }).promise();
    out.push(...(r.Items || []));
    lek = r.LastEvaluatedKey;
  } while (lek);
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const items = await scanAll();
  const byId = new Map(items.map((i) => [i.id, i]));
  const now = () => new Date().toISOString();
  const subsOf = (root: any) => items.filter((i) => i.slug && i.id !== root.id && repoOf(i) === repoOf(root));

  console.log(`\n===== HEAL ${HEAL.length} (apply=${apply}) =====`);
  for (const h of HEAL) {
    const root = byId.get(h.id);
    if (!root) { console.log(`  ✗ ${h.id} not found`); continue; }
    const owner = h.owner.includes("...") ? root.userId : h.owner;          // Seamate keeps its current owner
    const reassign = owner !== root.userId;
    const subs = subsOf(root);
    console.log(`\n  "${root.name}" -> ${h.subdomain}.agentwebforms.com${reassign ? `  [owner ${root.userId.slice(0,8)} -> ${owner.slice(0,8)}]` : ""}  (${subs.length} sub-pages)`);
    if (!apply) continue;
    try {
      if (reassign) {
        await dynamodb.update({ TableName: TABLE, Key: { id: root.id }, UpdateExpression: "SET userId = :u, updatedAt = :t", ExpressionAttributeValues: { ":u": owner, ":t": now() } }).promise();
      }
      const dr = await addSubdomain(owner, h.projectId, h.subdomain);
      const url = `https://${dr.domain}`;
      await dynamodb.update({ TableName: TABLE, Key: { id: root.id }, UpdateExpression: "SET customDomainUrl = :c, updatedAt = :t", ExpressionAttributeValues: { ":c": url, ":t": now() } }).promise();
      console.log(`     ✓ ${dr.domain}`);
      for (const s of subs) {
        const su = `${url}/${s.slug}`;
        const expr = reassign ? "SET deployedUrl = :u, customDomainUrl = :u, userId = :o, updatedAt = :t" : "SET deployedUrl = :u, customDomainUrl = :u, updatedAt = :t";
        const vals: any = reassign ? { ":u": su, ":o": owner, ":t": now() } : { ":u": su, ":t": now() };
        await dynamodb.update({ TableName: TABLE, Key: { id: s.id }, UpdateExpression: expr, ExpressionAttributeValues: vals }).promise();
        console.log(`       ↳ /${s.slug} -> ${su}`);
      }
    } catch (e: any) { console.log(`     ✗ ${e.message}`); }
  }

  console.log(`\n===== DUMP (soft-archive) ${DUMP_IDS.length} (apply=${apply}) =====`);
  for (const id of DUMP_IDS) {
    const root = byId.get(id);
    if (!root) { console.log(`  ✗ ${id} not found`); continue; }
    const subs = subsOf(root);
    console.log(`\n  archive "${root.name}" (owner ${(root.userId||"").slice(0,8)}, ${subs.length} sub-pages)`);
    if (!apply) continue;
    for (const rec of [root, ...subs]) {
      await dynamodb.update({ TableName: TABLE, Key: { id: rec.id }, UpdateExpression: "SET archived = :a, archivedAt = :t, updatedAt = :t", ExpressionAttributeValues: { ":a": true, ":t": now() } }).promise();
    }
    console.log(`     ✓ archived root + ${subs.length} sub-pages`);
  }
  console.log(`\nDone (apply=${apply}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
