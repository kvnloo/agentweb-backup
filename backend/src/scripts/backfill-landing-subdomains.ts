/**
 * Backfill agentwebforms.com subdomains for already-deployed landing pages that
 * are stuck on a raw *.vercel.app URL ("vercel junk"). Credit-free: it only calls
 * the Vercel domains API + updates DynamoDB — no v0 generation, no rebuild.
 *
 *   npx ts-node src/scripts/backfill-landing-subdomains.ts                 # dry-run
 *   npx ts-node src/scripts/backfill-landing-subdomains.ts --apply --limit=2
 *   npx ts-node src/scripts/backfill-landing-subdomains.ts --apply         # heal all
 *
 * Targets ONLY genuine junk: a deployed root page with a vercelProjectId, no
 * customDomainUrl, whose deployedUrl is a *.vercel.app URL (real custom domains
 * like start.foo.com are left alone). Healing a root re-points its sub-pages to
 * the new subdomain too. Additive + reversible — the old vercel.app URL keeps
 * working.
 */
import AWS from "aws-sdk";
import { addSubdomain, generateSubdomain } from "../services/customDomainService";

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const TABLE = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-LandingPages`;

const repoOf = (i: any): string | null => {
  const m = (i.githubRepoUrl || "").match(/github\.com\/[^/]+\/([^/]+)/);
  return m ? m[1] : null;
};

async function scanAll(): Promise<any[]> {
  const out: any[] = [];
  let lek: any = undefined;
  do {
    const r = await dynamodb.scan({ TableName: TABLE, ExclusiveStartKey: lek }).promise();
    out.push(...(r.Items || []));
    lek = r.LastEvaluatedKey;
  } while (lek);
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limArg ? parseInt(limArg.split("=")[1], 10) : Infinity;

  const items = await scanAll();
  const deployed = items.filter((i) => i.status === "deployed");
  const junkRoots = deployed.filter(
    (i) =>
      (i.isRootPage || !i.slug) &&
      !i.customDomainUrl &&
      i.vercelProjectId &&
      /vercel\.app/.test(i.deployedUrl || "")
  );

  console.log(`[backfill] ${junkRoots.length} junk root site(s) on raw vercel.app (apply=${apply}, limit=${limit})`);
  let healed = 0;

  for (const root of junkRoots) {
    if (healed >= limit) break;
    const subdomain = generateSubdomain(root.name || "page");
    console.log(`\n[${apply ? "APPLY" : "DRY"}] ${root.id} "${root.name}" -> ${subdomain}.agentwebforms.com  (was ${root.deployedUrl})`);
    if (!apply) {
      healed++;
      continue;
    }
    try {
      const dr = await addSubdomain(root.userId, root.vercelProjectId, subdomain);
      const customUrl = `https://${dr.domain}`;
      await dynamodb
        .update({
          TableName: TABLE,
          Key: { id: root.id },
          UpdateExpression: "SET customDomainUrl = :u, updatedAt = :t",
          ExpressionAttributeValues: { ":u": customUrl, ":t": new Date().toISOString() },
        })
        .promise();
      console.log(`   ✓ assigned ${dr.domain}`);

      // Re-point sub-pages of the same site onto the new subdomain.
      const repo = repoOf(root);
      const subs = deployed.filter((i) => i.slug && repoOf(i) === repo);
      for (const s of subs) {
        const newUrl = `${customUrl}/${s.slug}`;
        await dynamodb
          .update({
            TableName: TABLE,
            Key: { id: s.id },
            UpdateExpression: "SET deployedUrl = :u, customDomainUrl = :u, updatedAt = :t",
            ExpressionAttributeValues: { ":u": newUrl, ":t": new Date().toISOString() },
          })
          .promise();
        console.log(`     ↳ sub-page /${s.slug} -> ${newUrl}`);
      }
      healed++;
    } catch (e: any) {
      console.error(`   ✗ ${root.id}: ${e.message}`);
    }
  }
  console.log(`\n[backfill] ${apply ? "healed" : "would heal"} ${healed} root site(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
