/**
 * ENG-1839 — periodic sweep that records whether managed domains actually serve.
 *
 * Runs on a schedule rather than from a user request, deliberately. The reverted first attempt
 * fired verification from the landing-pages list read, which the portal polls every 10 seconds
 * while any page is deploying: every viewer of every shared list triggered its own fan-out,
 * with no dedup and no timeout. One sweep replaces all of that.
 *
 * SCOPE: only domains backing a page whose status is `deployed`.
 *
 * Not for cost — at ~58 domain records a full sweep is trivial. For signal quality. A domain
 * whose page is still building will fail a probe, and that failure is EXPECTED; a monitor that
 * reports expected failures gets tuned out, which is the same way the original bug survived
 * (everything read healthy, so nobody looked). Orphaned domains — attached to Vercel, backing
 * no page — are a different signal and are already detected by repair-overlong-subdomains.ts.
 */
import AWS from "aws-sdk";
import { probeDomain, decideFromVerdict } from "../services/domainReachabilityService";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const DOMAINS_TABLE = `${TABLE_PREFIX}AW-CustomDomains`;
const PAGES_TABLE = `${TABLE_PREFIX}AW-LandingPages`;

/** Probes run in parallel, but bounded — a sweep must not look like an outbound flood. */
export const SWEEP_CONCURRENCY = 4;

export interface SweepSummary {
  considered: number;
  probed: number;
  reachable: number;
  markedUnhealthy: number;
  recovered: number;
  stillSuspect: number;
  errors: number;
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

/**
 * Which domains are in scope: those backing at least one deployed page, matched by HOST so a
 * page whose stored URL carries a path still counts.
 *
 * Pure and exported so the scoping rule is testable without AWS.
 */
export function selectDomainsToProbe(domains: any[], pages: any[]): any[] {
  const deployedHosts = new Set<string>();
  for (const p of pages) {
    if (p.status !== "deployed" || !p.customDomainUrl) continue;
    try {
      deployedHosts.add(new URL(p.customDomainUrl).host);
    } catch {
      /* unparseable stored URL — cannot be matched, and is not this job's problem */
    }
  }
  return domains.filter((d) => d.domain && deployedHosts.has(d.domain));
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runDomainReachabilitySweep(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    considered: 0,
    probed: 0,
    reachable: 0,
    markedUnhealthy: 0,
    recovered: 0,
    stillSuspect: 0,
    errors: 0,
  };

  const [domains, pages] = await Promise.all([scanAll(DOMAINS_TABLE), scanAll(PAGES_TABLE)]);
  summary.considered = domains.length;

  const targets = selectDomainsToProbe(domains, pages);
  console.log(
    `[DomainReachability] ${targets.length} of ${domains.length} domain(s) back a deployed page`
  );

  await mapLimit(targets, SWEEP_CONCURRENCY, async (rec) => {
    try {
      const verdict = await probeDomain(rec.domain);
      const decision = decideFromVerdict(verdict, rec.consecutiveFailures ?? 0);
      summary.probed++;
      if (verdict.state === "reachable") summary.reachable++;

      const now = new Date().toISOString();
      const names: Record<string, string> = {};
      const values: Record<string, any> = {
        ":checkedAt": now,
        ":fails": decision.consecutiveFailures,
      };
      // lastReachabilityCheckAt is stamped on EVERY outcome, including failures. Without that
      // a record that always fails looks permanently unchecked and is re-selected forever.
      let expr = "SET lastReachabilityCheckAt = :checkedAt, consecutiveFailures = :fails";

      if (decision.nextStatus) {
        names["#status"] = "status";
        values[":status"] = decision.nextStatus;
        expr += ", #status = :status";
        if (decision.nextStatus === "error") {
          values[":reason"] = decision.errorMessage;
          expr += ", errorMessage = :reason";
          if (rec.status !== "error") summary.markedUnhealthy++;
        } else {
          expr += " REMOVE errorMessage";
          if (rec.status === "error") summary.recovered++;
        }
      } else {
        summary.stillSuspect++;
      }

      await dynamodb
        .update({
          TableName: DOMAINS_TABLE,
          Key: { id: rec.id },
          UpdateExpression: expr,
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
        })
        .promise();
    } catch (err: any) {
      // One bad record must not abort the sweep.
      summary.errors++;
      console.warn(`[DomainReachability] ${rec.domain}: ${err?.message}`);
    }
  });

  console.log(
    `[DomainReachability] probed=${summary.probed} reachable=${summary.reachable} ` +
      `newly-unhealthy=${summary.markedUnhealthy} recovered=${summary.recovered} ` +
      `suspect-not-yet-believed=${summary.stillSuspect} errors=${summary.errors}`
  );
  return summary;
}
