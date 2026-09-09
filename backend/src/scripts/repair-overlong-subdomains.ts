/**
 * ENG-1839 — repair managed subdomains whose FQDN is too long to receive a TLS certificate.
 *
 * Affected domains resolve in DNS but close the TLS handshake, so the page is unreachable
 * while every record still reads healthy. This moves each one onto a short prefix.
 *
 *   npx ts-node src/scripts/repair-overlong-subdomains.ts                       # dry-run, lists affected
 *   npx ts-node src/scripts/repair-overlong-subdomains.ts --apply \
 *       --map=<domainId>=<new-prefix> [--map=...] [--remove-old]
 *
 * DATA-PLANE. This module is CODE; running it against production is a separate, approved
 * step and is deliberately not performed by the PR that adds it (same treatment as
 * hardenSkills.ts / publishGateScopeRewrite.ts).
 *
 * Design notes, each from a defect found while fixing this ticket:
 *
 * - ADD BEFORE REMOVE. The new domain is attached and persisted before anything is detached.
 *   The portal's own subdomain editor did the opposite and could strand a page with no domain
 *   at all; do not repeat that ordering here. If the add fails, nothing has changed.
 *
 * - PREFIXES ARE NOT DERIVED. Every prefix must be passed explicitly via --map. These are
 *   customer-facing URLs and the obvious auto-derivation is wrong: generateSubdomain() would
 *   truncate the page's LLM-authored name, and a human guess already went wrong once on this
 *   ticket ("waterheater" for a customer whose product domain is smartwaterheater.ai). The
 *   dry-run prints a suggestion; a human chooses.
 *
 * - IDEMPOTENT. Records already within the ceiling are skipped, so a re-run is a no-op.
 */
import AWS from "aws-sdk";
import {
  addSubdomain,
  removeDomain,
  generateSubdomain,
  SUBDOMAIN_BASE,
  MAX_SUBDOMAIN_LABEL_LENGTH,
} from "../services/customDomainService";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});
const PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const DOMAINS_TABLE = `${PREFIX}AW-CustomDomains`;
const PAGES_TABLE = `${PREFIX}AW-LandingPages`;

/** Cert ceiling, mirroring customDomainService. A record is broken when its FQDN exceeds it. */
const MAX_FQDN = MAX_SUBDOMAIN_LABEL_LENGTH + 1 + SUBDOMAIN_BASE.length;

interface DomainRecord {
  id: string;
  userId: string;
  domain: string;
  vercelProjectId: string;
  type?: string;
  status?: string;
}

async function scanAll(table: string): Promise<any[]> {
  const out: any[] = [];
  let lek: any = undefined;
  do {
    const r = await dynamodb.scan({ TableName: table, ExclusiveStartKey: lek }).promise();
    out.push(...(r.Items || []));
    lek = r.LastEvaluatedKey;
  } while (lek);
  return out;
}

function parseMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const arg of process.argv.filter((a) => a.startsWith("--map="))) {
    const [id, prefix] = arg.slice("--map=".length).split("=");
    if (!id || !prefix) {
      throw new Error(`Malformed --map (expected --map=<domainId>=<prefix>): ${arg}`);
    }
    map[id] = prefix.toLowerCase();
  }
  return map;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const removeOld = process.argv.includes("--remove-old");
  const map = parseMap();

  const domains = (await scanAll(DOMAINS_TABLE)) as DomainRecord[];
  const broken = domains.filter(
    (d) => d.domain && d.domain.endsWith(SUBDOMAIN_BASE) && d.domain.length > MAX_FQDN
  );

  console.log(
    `[repair] ceiling: label ${MAX_SUBDOMAIN_LABEL_LENGTH}, FQDN ${MAX_FQDN}. ` +
      `${broken.length} of ${domains.length} domain record(s) exceed it. apply=${apply}`
  );

  if (broken.length === 0) {
    console.log("[repair] nothing to do.");
    return;
  }

  // Pages are matched by host so a page whose customDomainUrl carries a path is still found.
  const pages = await scanAll(PAGES_TABLE);
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };

  let repaired = 0;
  for (const rec of broken) {
    const suggestion = generateSubdomain(rec.domain.replace(`.${SUBDOMAIN_BASE}`, ""));
    const chosen = map[rec.id];
    const affectedPages = pages.filter(
      (p) => p.customDomainUrl && hostOf(p.customDomainUrl) === rec.domain
    );

    console.log(
      `\n[${apply ? "APPLY" : "DRY"}] ${rec.id}  user=${rec.userId}\n` +
        `   current : ${rec.domain} (${rec.domain.length} chars — cannot be certificated)\n` +
        `   new     : ${chosen ? `${chosen}.${SUBDOMAIN_BASE}` : `(none given — suggestion: ${suggestion})`}\n` +
        `   pages   : ${affectedPages.length ? affectedPages.map((p) => p.id).join(", ") : "(none reference this host directly)"}`
    );

    if (!apply) continue;

    if (!chosen) {
      console.error(
        `   ✗ skipped — no --map=${rec.id}=<prefix> given. Prefixes are customer-facing and ` +
          `are never derived automatically; pass one explicitly.`
      );
      continue;
    }

    try {
      // 1. Attach the replacement FIRST. addSubdomain re-validates length, so a bad prefix
      //    fails here, before anything has been detached or rewritten.
      const created = await addSubdomain(rec.userId, rec.vercelProjectId, chosen);
      const newUrl = `https://${created.domain}`;
      console.log(`   ✓ attached ${created.domain}`);

      // 2. Re-point pages that referenced the broken host, preserving any path.
      for (const p of affectedPages) {
        const path = (() => {
          try {
            return new URL(p.customDomainUrl).pathname;
          } catch {
            return "/";
          }
        })();
        const rewritten = path && path !== "/" ? `${newUrl}${path}` : newUrl;
        await dynamodb
          .update({
            TableName: PAGES_TABLE,
            Key: { id: p.id },
            UpdateExpression: "SET customDomainUrl = :u, updatedAt = :t",
            ExpressionAttributeValues: { ":u": rewritten, ":t": new Date().toISOString() },
          })
          .promise();
        console.log(`     ↳ page ${p.id} -> ${rewritten}`);
      }

      // 3. Only now detach the old one. Off by default: the broken domain is already
      //    unreachable, so leaving it attached costs nothing, while removing it is an
      //    irreversible Vercel mutation. Opt in with --remove-old.
      if (removeOld) {
        await removeDomain(rec.id, rec.userId);
        console.log(`   ✓ detached ${rec.domain}`);
      } else {
        console.log(`   • left ${rec.domain} attached (pass --remove-old to detach)`);
      }

      repaired++;
    } catch (e: any) {
      console.error(`   ✗ ${rec.id}: ${e.message}`);
    }
  }

  console.log(`\n[repair] ${apply ? "repaired" : "would repair"} ${repaired} record(s).`);
  if (!apply) {
    console.log(
      "[repair] dry-run only. Re-run with --apply and a --map=<domainId>=<prefix> per record."
    );
  }
}

main().catch((e) => {
  console.error("[repair] fatal:", e);
  process.exit(1);
});
