#!/usr/bin/env python3
"""Re-check the enrichment cost estimate against what prod actually booked (ENG-2987).

READ-ONLY. It only calls `aws logs describe-log-groups|filter-log-events` and `aws dynamodb scan|get-item`; it writes
nothing to AWS and prints aggregates only (a 6-character user id prefix, counts and dollars; never an email, a lead or a
field value). Left out as non-customers: test accounts (by email), platform admins (`isAdmin`), every account on the
internal domains (--exclude-domains, default agentweb.pro and argusoft.com) and any --exclude-user-ids. Real customer
accounts are kept whatever their email domain.

What it does: joins the enrichment runs found in the prod logs ("runEnrichment START" / "runEnrichment DONE") to the
usage ledger (AW-UsageRecords, features crm_enrichment and enrichment) per account and day, then prints the booked
dollars per processed contact next to what the estimate formula quotes for leads that already have an email:

    quote per contact = fields * llmPerFieldPerLead + lookupPerLead + webSearchPerLead

where `fields` applies the customer quote's `effectiveFieldCount` formula (included fields plus their smart-field
dependencies, at least 1) to the list's SAVED enrichment config, or `referenceFieldCount` when there is none. The customer
quote counts the saved config merged with the list's current columns, so a column added to the list after the config was
saved counts there but not here (about 3% of the ratio per column).

The per-contact quote has no term for the paid add-ons, so booked dollars here EXCLUDE them: the Apollo email search
(`apollo:waterfall_email`) and Enigma (`enigma:*`, which the customer quote adds separately for card-revenue fields).
They are shown in their own columns.

Only the three rate constants (and referenceFieldCount) are read from backend/src/services/enrichmentCostEstimate.ts;
the formula above is duplicated here, so if `estimateEnrichmentCost` or `effectiveFieldCount` changes shape, update this
script. The ledger is per user and day, so a day that mixes an enrich run with a preview or another run is compared as a
whole (booked and contacts both include every run of that account-day). The prod log group keeps only 14 days: run this
at least every 14 days or the oldest runs are gone (the script warns when --since reaches into the lost part).

It ends with a verdict: below --min-contacts, or with fewer than --min-customers accounts that each supplied at least
--min-customer-contacts, it says INSUFFICIENT DATA and you must not retune.

Usage (needs read access to the prod CloudWatch log group and the AW-* DynamoDB tables). --since is required: choose
the day AFTER the last change to pricing or the enrichment pipeline, and keep it until the data is enough, because a
window that includes runs from before a change shows a false DRIFT:
    python3 scripts/enrichment-estimate-calibration.py --since 2026-11-13
See docs/enrichment-estimate-calibration-runbook.md for when to run it and how to read the result.
"""
import argparse
import ast
import collections
import datetime as dt
import json
import math
import os
import re
import shlex
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ESTIMATE_SRC = os.path.join(REPO, "backend", "src", "services", "enrichmentCostEstimate.ts")
DEFAULT_LOG_GROUP = "/aws/elasticbeanstalk/Agentweb-backend-env-prod-3/var/log/web.stdout.log"
LEDGER_FEATURES = ("crm_enrichment", "enrichment")
EMAIL_SEARCH_MODEL = "apollo:waterfall_email"
ENIGMA_PREFIX = "enigma:"


def short(text, limit=60):
    """Keep error messages short: a hostile source line can be tens of kilobytes."""
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "... (%d characters)" % len(text)


def scrub(text, limit=300):
    """AWS CLI error text without ARNs or email addresses (an SSO session name can be an email)."""
    text = re.sub(r"arn:aws[a-z-]*:[^\s'\",]+", "<arn>", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", "<email>", text)
    return text.strip()[:limit]


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def read_rate(name):
    """Read one numeric constant (a literal or simple arithmetic such as `(2.673 + 2.128) / 118`) from the source."""
    src = open(ESTIMATE_SRC, encoding="utf-8").read()
    m = re.search(r"^\s*%s:\s*([0-9.+\-*/() ]+?),\s*(?://.*)?$" % re.escape(name), src, re.M)
    if not m:
        sys.exit("cannot find %s in %s: did the estimate change shape? Update this script." % (name, ESTIMATE_SRC))
    val = _arith(m.group(1).strip(), name)
    if not (math.isfinite(val) and val > 0):
        sys.exit("%s must be a finite number above zero, got %s" % (name, short(val)))
    return val


def _arith(expr, name):
    """Evaluate numbers with + - * / and parentheses only, by walking the parsed tree (no eval)."""
    ops = {ast.Add: lambda x, y: x + y, ast.Sub: lambda x, y: x - y, ast.Mult: lambda x, y: x * y, ast.Div: lambda x, y: x / y}

    def walk(n):
        if isinstance(n, ast.Expression):
            return walk(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return float(n.value)
        if isinstance(n, ast.BinOp) and type(n.op) in ops:
            return ops[type(n.op)](walk(n.left), walk(n.right))
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
            return -walk(n.operand)
        raise ValueError("unsupported expression")

    try:
        return walk(ast.parse(expr, mode="eval"))
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError, RecursionError, MemoryError):
        sys.exit("unexpected expression for %s: %s" % (name, short(expr)))


class Aws:
    def __init__(self, cli, region):
        self.base = shlex.split(cli) + ["--region", region]

    def __call__(self, *args):
        r = subprocess.run(self.base + list(args) + ["--output", "json"], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("aws %s failed: %s" % (" ".join(args[:2]), scrub(r.stderr)))
        return json.loads(r.stdout) if r.stdout.strip() else {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", required=True,
                    help="first UTC day to include, YYYY-MM-DD, zero-padded. Pick the day AFTER the last change to pricing or the "
                         "enrichment pipeline and keep it until the data is enough: runs from before a change give a false DRIFT")
    ap.add_argument("--exclude-emails", default="test@account.com",
                    help="comma-separated internal/test account emails to leave out (default: test@account.com)")
    ap.add_argument("--exclude-domains", default="agentweb.pro,argusoft.com",
                    help="comma-separated email domains of internal staff; every account on them is left out (default: agentweb.pro,argusoft.com)")
    ap.add_argument("--exclude-user-ids", default="", help="comma-separated user ids to leave out as well")
    ap.add_argument("--aws", default=os.environ.get("AWS_CLI", "aws"), help="aws command (default: $AWS_CLI or 'aws')")
    ap.add_argument("--region", default="us-west-2")
    ap.add_argument("--log-group", default=DEFAULT_LOG_GROUP)
    ap.add_argument("--min-contacts", type=int, default=100, help="below this many customer contacts: no retune (default 100)")
    ap.add_argument("--min-customers", type=int, default=3, help="below this many qualifying accounts: no retune (default 3)")
    ap.add_argument("--min-customer-contacts", type=int, default=10,
                    help="an account counts toward --min-customers only with at least this many contacts (default 10)")
    ap.add_argument("--tolerance", type=float, default=0.25, help="retune if booked/quote differs from 1 by more (default 0.25)")
    a = ap.parse_args()
    now = dt.datetime.now(dt.timezone.utc)
    try:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", a.since):  # ASCII only; strptime accepts 2026-11-5 and the ledger date filter is a string compare
            raise ValueError
        since_dt = dt.datetime.strptime(a.since, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        sys.exit("--since must be a real, zero-padded date, YYYY-MM-DD (for example 2026-11-05)")
    if since_dt.date() > now.date():
        sys.exit("--since %s is in the future" % a.since)

    llm_field = read_rate("llmPerFieldPerLead")
    lookup = read_rate("lookupPerLead")
    web = read_rate("webSearchPerLead")
    reference_value = read_rate("referenceFieldCount")
    if reference_value != int(reference_value):
        sys.exit("referenceFieldCount must be a whole number, got %s" % short(reference_value))
    reference_fields = int(reference_value)
    aws = Aws(a.aws, a.region)

    # Accounts to leave out: test emails (both cases), platform admins, internal domains (exact suffix, checked below), explicit ids.
    excl_emails = sorted({v for raw in a.exclude_emails.split(",") if raw.strip() for v in (raw.strip(), raw.strip().lower())})
    domains = sorted({x.strip().lower().lstrip("@") for x in a.exclude_domains.split(",") if x.strip()})
    vals = {":t": {"BOOL": True}}
    clauses = ["isAdmin = :t"]
    for i, e in enumerate(excl_emails):
        vals[":e%d" % i] = {"S": e}
    if excl_emails:
        clauses.append("email IN (%s)" % ", ".join(":e%d" % i for i in range(len(excl_emails))))
    for i, dom in enumerate(domains):
        vals[":d%d" % i] = {"S": "@" + dom}
        clauses.append("contains(email, :d%d)" % i)
    d = aws("dynamodb", "scan", "--table-name", "AW-Users", "--projection-expression", "userId, email, isAdmin",
            "--filter-expression", " OR ".join(clauses), "--expression-attribute-values", json.dumps(vals))
    lower_emails = {e.lower() for e in excl_emails}
    test_ids = {x.strip() for x in a.exclude_user_ids.split(",") if x.strip()}
    for u in d.get("Items", []):
        em = (u.get("email", {}).get("S") or "").lower()  # kept in memory only, never printed
        if u.get("isAdmin", {}).get("BOOL") or em in lower_emails or any(em.endswith("@" + dom) for dom in domains):
            test_ids.add(u["userId"]["S"])

    start_ms = int(since_dt.timestamp() * 1000)
    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", a.log_group).get("logGroups", [])
    keep = next((g.get("retentionInDays") for g in groups if g.get("logGroupName") == a.log_group), None)
    oldest_day = (now - dt.timedelta(days=keep)).date() if keep else None
    if oldest_day and since_dt.date() < oldest_day:
        print("WARNING: the log group keeps only %d days, so runs before %s are already gone; the result below starts later than --since."
              % (keep, oldest_day.strftime("%Y-%m-%d")))
    elif oldest_day and since_dt.date() == oldest_day:
        print("WARNING: the log group keeps only %d days, so the early hours of %s are already gone but the ledger counts the whole day; "
              "start one day later for a clean result." % (keep, a.since))
    ev = lambda pat: aws("logs", "filter-log-events", "--log-group-name", a.log_group, "--start-time", str(start_ms),
                         "--filter-pattern", pat).get("events", [])
    starts = {}
    for x in ev('"runEnrichment START"'):
        m = re.search(r"listId=(\S+) userId=(\S+) mode=(\S+) runId=(\S+)", x["message"])
        if m:
            starts[m.group(4)] = (m.group(2), m.group(3), m.group(1))
    finished = {}
    for x in ev('"runEnrichment DONE"'):
        m = re.search(r"runId=(\S+) processed=(\d+)", x["message"])
        if m and m.group(1) not in finished:  # a repeated DONE line must not count a run twice
            finished[m.group(1)] = (int(m.group(2)), x["timestamp"])
    runs = []
    for rid, (processed, ts) in finished.items():
        if rid not in starts:
            continue
        uid, mode, lid = starts[rid]
        day = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        runs.append(dict(uid=uid, day=day, mode=mode, p=processed, lid=lid))
    cust = [r for r in runs if r["uid"] not in test_ids]
    print("runs since %s: %d in the logs, %d from excluded accounts, %d customer runs" % (a.since, len(runs), len(runs) - len(cust), len(cust)))
    unfinished = sum(1 for rid in starts if rid not in finished)
    orphans = sum(1 for rid in finished if rid not in starts)
    print("not counted: %s started but not finished (still running or crashed; their cost sits in the booked dollars with no contacts), "
          "%s finished whose start is before --since" % (plural(unfinished, "run"), plural(orphans, "run")))

    fields = {}
    for lid in {r["lid"] for r in cust}:
        d = aws("dynamodb", "get-item", "--table-name", "AW-LeadLists", "--key", json.dumps({"listId": {"S": lid}}),
                "--projection-expression", "enrichmentConfig")
        cfg = d.get("Item", {}).get("enrichmentConfig", {}).get("M")
        if not cfg:
            fields[lid] = reference_fields  # the customer quote falls back to referenceFieldCount without a saved config
            continue
        inc = [x for x in cfg.get("fields", {}).get("L", []) if x.get("M", {}).get("include", {}).get("BOOL")]
        deps = sum(len(x["M"].get("smartDependencies", {}).get("L", [])) for x in inc)
        fields[lid] = max(1, len(inc) + deps)

    led = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
    d = aws("dynamodb", "scan", "--table-name", "AW-UsageRecords", "--page-size", "1000",
            "--projection-expression", "userId, #d, model, feature, callCount, costMicroUsd",
            "--filter-expression", "#d >= :s AND (feature = :a OR feature = :b)", "--expression-attribute-names", '{"#d":"date"}',
            "--expression-attribute-values", json.dumps({":s": {"S": a.since}, ":a": {"S": LEDGER_FEATURES[0]}, ":b": {"S": LEDGER_FEATURES[1]}}))
    for r in d.get("Items", []):
        k = (r["userId"]["S"], r["date"]["S"])
        led[k][r["model"]["S"]][0] += int(r["callCount"]["N"])
        led[k][r["model"]["S"]][1] += int(r["costMicroUsd"]["N"])

    agg = collections.defaultdict(lambda: dict(p=0, fp=0, modes=collections.Counter()))
    for r in cust:
        g = agg[(r["uid"], r["day"])]
        g["p"] += r["p"]; g["fp"] += r["p"] * fields[r["lid"]]; g["modes"][r["mode"]] += r["p"]

    print("\n%-13s %-14s %8s %6s %8s %7s %10s %12s  %-22s %s" % ("user/day", "modes", "contacts", "fields", "booked$*", "$/ctc*", "quote$/ctc", "booked/quote", "email-search $ (calls)", "enigma $"))
    tot_b = tot_q = tot_n = 0
    by_account = collections.Counter()
    for (uid, day), g in sorted(agg.items(), key=lambda kv: kv[0][1]):
        n = g["p"]
        if n == 0:
            continue
        L = led.get((uid, day), {})
        wf = L.get(EMAIL_SEARCH_MODEL, [0, 0])
        eg = sum(v[1] for k, v in L.items() if k.startswith(ENIGMA_PREFIX))
        total = (sum(v[1] for v in L.values()) - wf[1] - eg) / 1e6  # excludes the paid add-ons (own columns)
        flds = g["fp"] / n  # weighted by contacts
        q = flds * llm_field + lookup + web
        print("%-13s %-14s %8d %6.1f %8.2f %7.3f %10.3f %12.2f  %-22s %.2f" % ("%s/%s" % (uid[:6], day[5:]), ",".join(g["modes"]), n, flds, total, total / n, q, total / n / q, "%.2f (%d)" % (wf[1] / 1e6, wf[0]), eg / 1e6))
        if g["modes"].get("enrich", 0) > 0:
            tot_b += total; tot_q += q * n; tot_n += n; by_account[uid] += n

    print("\n* excluding the paid add-ons (the Apollo email search and Enigma), which are not part of the per-contact quote")
    print("\nVERDICT")
    if tot_n == 0:
        print("  No customer enrich-mode runs in the window: nothing to compare.")
        return
    if tot_b <= 0:
        print("  No booked cost found in the ledger for these runs (not written yet, or the wrong window): cannot compare.")
        return
    ratio = tot_b / tot_q
    qualifying = [u for u, c in by_account.items() if c >= a.min_customer_contacts]
    print("  %d contacts from %s: booked $%.2f vs quote $%.2f (booked/quote = %.2f), paid add-ons excluded"
          % (tot_n, plural(len(by_account), "account"), tot_b, tot_q, ratio))
    print("  the largest account supplies %d%% of the contacts; %d of them supplied at least %d contacts each (the gate needs %d)"
          % (round(100 * max(by_account.values()) / tot_n), len(qualifying), a.min_customer_contacts, a.min_customers))
    if tot_n < a.min_contacts or len(qualifying) < a.min_customers:
        print("  INSUFFICIENT DATA (need >= %d contacts and >= %d accounts with >= %d contacts each): do NOT retune; run again later with the same --since."
              % (a.min_contacts, a.min_customers, a.min_customer_contacts))
    elif abs(ratio - 1) > a.tolerance:
        print("  DRIFT beyond +/-%d%%: retune ENRICHMENT_COST_RATES_USD in enrichmentCostEstimate.ts (see the runbook)." % round(a.tolerance * 100))
    else:
        print("  Within +/-%d%%: leave the constants alone." % round(a.tolerance * 100))


if __name__ == "__main__":
    main()
