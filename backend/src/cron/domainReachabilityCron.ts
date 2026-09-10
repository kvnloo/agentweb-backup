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
/**
 * How recently a domain must have been checked for this sweep to skip it.
 *
 * Slightly under the 24h cadence so a run that fires a few minutes early — clock drift, a
 * restart, a slow previous sweep — does not skip a whole day.
 */
export const MIN_RECHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * How often the sweep runs. Declared HERE, not in server.ts, so the detection-latency test can
 * derive the real cadence rather than hand-copying it — a copied literal keeps the promise
 * "reported within 2 days" green while the schedule silently moves to weekly.
 */
export const REACHABILITY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function selectDomainsToProbe(
  domains: any[],
  pages: any[],
  now: number = Date.now(),
  minRecheckMs: number = MIN_RECHECK_INTERVAL_MS
): any[] {
  const deployedHosts = new Set<string>();
  // Deployed pages that store NO url. Their working URL comes from the domain row itself
  // (assignManagedSubdomain persists the page url in a separate write that can fail), so
  // matching only on stored hosts would leave exactly the legacy/broken population unmonitored.
  const deployedProjects = new Set<string>();

  for (const p of pages) {
    if (p.status !== "deployed") continue;
    if (!p.customDomainUrl) {
      if (p.vercelProjectId) deployedProjects.add(p.vercelProjectId);
      continue;
    }
    try {
      deployedHosts.add(new URL(p.customDomainUrl).host);
    } catch {
      /* unparseable stored URL — fall back to project matching below */
      if (p.vercelProjectId) deployedProjects.add(p.vercelProjectId);
    }
  }

  return domains.filter(
    (d) =>
      d.domain &&
      /*
       * Already checked within this period → skip. This makes the sweep safe to run more than
       * once per period. It is NOT a substitute for a lock, and the difference matters:
       *
       *   It does nothing for instances sweeping SIMULTANEOUSLY — both scan before either
       *   writes, so both see the same stale timestamps and both probe. (The MULTI-INSTANCE
       *   bullet below is about the STAGGERED case, minutes apart, which is the one the guard
       *   does prevent. Simultaneous and staggered fail differently: staggered double-counts,
       *   simultaneous does not.) Moving to a fixed
       *   06:15 UTC schedule (see server.ts) actually makes simultaneous the normal case,
       *   where boot-relative scheduling used to stagger instances naturally. What saves us
       *   there is that `consecutiveFailures` is read-then-set: two instances both read the
       *   same prior and both write prior+1, so the lost update cancels the double-count and
       *   the counter stays correct. The residual harm is duplicate probe traffic to customer
       *   origins — the very thing the daily cadence was chosen to reduce — and duplicate
       *   writes. Real coordination is still owed if this environment ever scales out.
       *
       * What the guard does cover:
       *
       *   - MULTI-INSTANCE. The cron is an in-process interval, so every instance runs its
       *     own. `consecutiveFailures` is read-then-set, not an atomic ADD, so two instances
       *     firing minutes apart would advance a domain's counter twice in one period and trip
       *     the confirmation threshold early — telling a customer their site is down on the
       *     strength of fewer real days of failure than the threshold claims.
       *   - RESTARTS. A deploy or crash-loop restarts the timer; without this, each restart
       *     re-probes every domain. That was previously papered over with a 10-minute boot
       *     delay, which only narrowed the window.
       *   - PARTIAL SWEEPS. If a sweep dies halfway, the domains it never stamped are still
       *     due, so the next run picks up exactly the remainder. Self-healing, no lease to
       *     expire or leak.
       *
       * A missing timestamp means never checked, which is always due.
       */
      (() => {
        const last = d.lastReachabilityCheckAt ? Date.parse(d.lastReachabilityCheckAt) : NaN;
        // A FUTURE timestamp means the stored value is wrong, not that the domain was checked.
        // Without `last > now` the subtraction goes negative and the domain is skipped until
        // wall-clock catches up — one bad write from a skewed clock silently retires it from
        // monitoring for as long as the skew, with no log and no error: `targets` just gets
        // shorter. Silence mistaken for health is the exact failure this monitor exists to end.
        return Number.isNaN(last) || last > now || now - last >= minRecheckMs;
      })() &&
      // Only domains Vercel considers verified. A custom domain sitting at
      // `pending_verification` because the customer has not pointed DNS yet WILL fail a probe,
      // and that failure is expected — the same reasoning that excludes not-yet-deployed pages.
      // Without this, a normal domain-setup flow shows "this page may not be reachable" three
      // hours in. Managed subdomains are written `status: "active"` unconditionally by
      // addSubdomain, so this excludes nothing this ticket is about.
      d.status === "active" &&
      (deployedHosts.has(d.domain) ||
        (d.vercelProjectId !== undefined && deployedProjects.has(d.vercelProjectId)))
  );
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

/*
 * KNOWN GAP — no prober-health circuit breaker.
 *
 * The confirmation threshold defends against a per-domain blip. It does nothing about a fault
 * in the PROBER: an egress DNS failure, a NAT/proxy outage, or a security-group change on the
 * EB instance makes every probe fail at once, and the sweep would eventually tell every
 * customer their page is unreachable. A monitor that cries wolf gets tuned out, which is the
 * same way the original bug survived.
 *
 * Not fixed here, deliberately, because the blast radius is bounded by the SUSPECT/DEFINITIVE
 * split: every failure a prober-side fault can produce is classified SUSPECT, so nothing
 * reaches a customer until UNREACHABLE_CONFIRMATIONS consecutive daily rounds have failed. A
 * transient outage self-heals long before that, and a multi-day total egress failure is an
 * incident someone is already looking at.
 *
 * That bound holds only while the certificate trust/validity codes stay SUSPECT (see
 * domainReachabilityService.ts) — `decideFromVerdict` commits an unreachable verdict BEFORE
 * consulting the threshold, so a single definitive code bypasses this bound entirely. One round
 * under an intercepting proxy, a broken CA store, or an expired root anywhere in the chain
 * would otherwise tell the entire customer base their own certificates are bad. Promoting any
 * of those codes back to DEFINITIVE invalidates this paragraph — and that has already been
 * tried once with CERT_HAS_EXPIRED and reverted, so read that entry before trying again.
 *
 * The real fix is a batch-level guard: if a sweep's failure ratio exceeds ~50%, treat the
 * prober as suspect and skip persisting verdicts for that round. It needs a two-phase
 * restructure (probe all, then decide), which is why it is not bolted on here.
 */
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
    `[DomainReachability] ${targets.length} of ${domains.length} domain(s) due this run ` +
      `(in scope and not checked within ${Math.round(MIN_RECHECK_INTERVAL_MS / 3600000)}h)`
  );

  await mapLimit(targets, SWEEP_CONCURRENCY, async (rec) => {
    try {
      const verdict = await probeDomain(rec.domain);
      const decision = decideFromVerdict(verdict, rec.consecutiveFailures ?? 0);
      summary.probed++;
      if (verdict.state === "reachable") summary.reachable++;

      const now = new Date().toISOString();
      const values: Record<string, any> = {
        ":checkedAt": now,
        ":fails": decision.consecutiveFailures,
      };
      // Reachability is written to its OWN attribute, never to `status`.
      //
      // `status` is the Vercel VERIFICATION state, owned by addCustomDomain, addSubdomain and
      // verifyDomain. getProjectDomain selects `active` then `pending_verification`, so a
      // record set to "error" matches neither and returns null — which renders a customer's
      // custom domain as "not configured" in the portal. Three 5xx responses from their own
      // site would have been enough to trigger that.
      //
      // lastReachabilityCheckAt is stamped on EVERY outcome including failures, so a record
      // that always fails cannot look permanently unchecked and be re-selected forever.
      let expr =
        "SET lastReachabilityCheckAt = :checkedAt, consecutiveFailures = :fails";

      if (decision.nextStatus) {
        values[":reach"] = decision.nextStatus === "active" ? "reachable" : "unreachable";
        expr += ", reachabilityStatus = :reach";
        if (decision.nextStatus === "error") {
          values[":reason"] = decision.errorMessage;
          expr += ", reachabilityError = :reason";
          if (rec.reachabilityStatus !== "unreachable") summary.markedUnhealthy++;
        } else {
          expr += " REMOVE reachabilityError";
          if (rec.reachabilityStatus === "unreachable") summary.recovered++;
        }
      } else {
        summary.stillSuspect++;
      }

      await dynamodb
        .update({
          TableName: DOMAINS_TABLE,
          Key: { id: rec.id },
          UpdateExpression: expr,
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
