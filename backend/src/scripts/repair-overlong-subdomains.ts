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

interface PageRecord {
  id: string;
  customDomainUrl?: string;
  subdomainPrefix?: string;
  vercelProjectId?: string;
}

/** Host of a URL, or "" when it is absent or unparseable. */
export function hostOfUrl(url: string | undefined): string {
  try {
    return new URL(url as string).host;
  } catch {
    return "";
  }
}

/**
 * Decide what a record needs, without touching anything. Exported so the risky part — orphan
 * classification and the removeDomain cascade blast radius — is unit-testable away from AWS.
 *
 * `cascade` mirrors removeDomain()'s own side effect: it deletes the domain row, then scans
 * pages on the SAME vercelProjectId that HAVE a `subdomainPrefix`, and blanks customDomainUrl
 * + subdomainPrefix on any whose customDomainUrl CONTAINS the removed domain as a substring.
 * A non-empty cascade means detaching would damage those pages.
 */
export function classifyRecord(
  rec: DomainRecord,
  pages: PageRecord[]
): {
  isOrphan: boolean;
  affectedPages: PageRecord[];
  /** Same-project pages with no stored URL. Block a detach; nothing to rewrite. */
  projectPagesWithoutUrl: PageRecord[];
  cascade: PageRecord[];
} {
  // Pages that name this exact host — these are the ones whose URL gets rewritten.
  const affectedPages = pages.filter(
    (p) => p.customDomainUrl && hostOfUrl(p.customDomainUrl) === rec.domain
  );

  // Pages on the same Vercel project that store NO customDomainUrl at all. These are invisible
  // to the host match above, and treating them as absent is dangerous: `assignManagedSubdomain`
  // creates the domain record and persists the page's customDomainUrl in a SEPARATE write, so a
  // failure between the two leaves a deployed page whose only working URL comes from the domain
  // row. Classifying such a record as an orphan and detaching it destroys that page's URL.
  //
  // They are deliberately NOT added to affectedPages: there is no stored URL to rewrite. They
  // only make the record count as in-use, which is what stops the detach.
  const projectPagesWithoutUrl = pages.filter(
    (p) =>
      p.vercelProjectId !== undefined &&
      p.vercelProjectId === rec.vercelProjectId &&
      !p.customDomainUrl
  );

  const cascade = pages.filter(
    (p) =>
      p.vercelProjectId === rec.vercelProjectId &&
      p.subdomainPrefix !== undefined &&
      typeof p.customDomainUrl === "string" &&
      p.customDomainUrl.includes(rec.domain)
  );

  return {
    isOrphan: affectedPages.length === 0 && projectPagesWithoutUrl.length === 0,
    affectedPages,
    projectPagesWithoutUrl,
    cascade,
  };
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
  const pages = (await scanAll(PAGES_TABLE)) as PageRecord[];

  let repaired = 0;
  for (const rec of broken) {
    const suggestion = generateSubdomain(rec.domain.replace(`.${SUBDOMAIN_BASE}`, ""));
    const chosen = map[rec.id];
    const { isOrphan, affectedPages, projectPagesWithoutUrl, cascade } = classifyRecord(rec, pages);

    // A broken record that NO page references is an orphan: attached to Vercel, unreachable,
    // and unused. Minting a replacement would just create a second domain nobody points at.
    // The correct action is to detach it, not repair it. One of the three records found in
    // production is this case.

    console.log(
      `\n[${apply ? "APPLY" : "DRY"}] ${rec.id}  user=${rec.userId}  ${isOrphan ? "[ORPHAN]" : "[IN USE]"}\n` +
        `   current : ${rec.domain} (${rec.domain.length} chars — cannot be certificated)\n` +
        (isOrphan
          ? `   action  : detach only — no page references this host, so a replacement would go unused` +
            `${removeOld ? "" : " (pass --remove-old to actually detach)"}\n`
          : `   new     : ${chosen ? `${chosen}.${SUBDOMAIN_BASE}` : `(none given — suggestion: ${suggestion})`}\n`) +
        `   pages   : ${affectedPages.length ? affectedPages.map((p) => p.id).join(", ") : "(none)"}` +
        (projectPagesWithoutUrl.length
          ? `\n   note    : ${projectPagesWithoutUrl.length} page(s) on this project store no URL ` +
            `(${projectPagesWithoutUrl.map((p) => p.id).join(", ")}) — they may depend on this ` +
            `record, so it is NOT treated as an orphan`
          : "") +
        (() => {
          const c = cascade;
          return c.length
            ? `\n   ⚠ CASCADE: detaching would ALSO blank customDomainUrl+subdomainPrefix on: ${c
                .map((p) => p.id)
                .join(", ")} — review before using --remove-old`
            : `\n   cascade : none (no page on this project carries a subdomainPrefix matching this host)`;
        })()
    );

    if (!apply) continue;

    if (isOrphan) {
      if (!removeOld) {
        console.log(`   • left attached — re-run with --remove-old to detach this orphan`);
        continue;
      }
      if (cascade.length) {
        console.error(
          `   ✗ REFUSING to detach — removeDomain would blank customDomainUrl on ` +
            `${cascade.length} page(s): ${cascade.map((p) => p.id).join(", ")}. ` +
            `Resolve those first.`
        );
        continue;
      }
      try {
        await removeDomain(rec.id, rec.userId);
        console.log(`   ✓ detached orphan ${rec.domain}`);
        repaired++;
      } catch (e: any) {
        console.error(`   ✗ ${rec.id}: ${e.message}`);
      }
      continue;
    }

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
        let path = "/";
        try {
          path = new URL(p.customDomainUrl as string).pathname;
        } catch {
          path = "/";
        }
        const rewritten = path && path !== "/" ? `${newUrl}${path}` : newUrl;
        await dynamodb
          .update({
            TableName: PAGES_TABLE,
            Key: { id: p.id },
            UpdateExpression: "SET customDomainUrl = :u, updatedAt = :t",
            ExpressionAttributeValues: { ":u": rewritten, ":t": new Date().toISOString() },
          })
          .promise();
        // Keep the local snapshot in step with the write, so the pre-detach check below
        // reflects what is actually stored rather than the pre-run state.
        p.customDomainUrl = rewritten;
        console.log(`     ↳ page ${p.id} -> ${rewritten}`);
      }

      // 3. Only now detach the old one. Off by default: the broken domain is already
      //    unreachable, so leaving it attached costs nothing, while removing it is an
      //    irreversible Vercel mutation. Opt in with --remove-old.
      if (removeOld) {
        // The cascade is what makes a detach unsafe, and it must be checked HERE, not only on
        // the orphan branch. removeDomain blanks customDomainUrl + subdomainPrefix on any
        // same-project page whose URL CONTAINS this host as a substring — a page on
        // `shop.<this-host>` is in the cascade but NOT in affectedPages (different host), so it
        // is never rewritten above and would simply lose its domain.
        //
        // A previous version guarded with a recomputed "stale" check instead. That was dead
        // code: it tested the freshly-REWRITTEN url (short, new host) for the OLD host, which
        // can never match, so it always passed and the detach always proceeded.
        if (cascade.length) {
          console.error(
            `   ✗ NOT detaching — removeDomain would blank customDomainUrl + subdomainPrefix on ` +
              `${cascade.length} page(s): ${cascade.map((p) => p.id).join(", ")}. ` +
              `Repair or re-point those first. The old domain is unreachable either way, so ` +
              `leaving it attached costs nothing.`
          );
        } else {
          await removeDomain(rec.id, rec.userId);
          console.log(`   ✓ detached ${rec.domain}`);
        }
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

// Run ONLY when executed directly. Without this guard, merely importing the module — which
// the unit tests do, and which any future caller might — executes main() against whatever
// credentials and argv are in scope. For a script that attaches and detaches live customer
// domains, an accidental import must never be able to mutate anything.
if (require.main === module) {
  main().catch((e) => {
    console.error("[repair] fatal:", e);
    process.exit(1);
  });
}
