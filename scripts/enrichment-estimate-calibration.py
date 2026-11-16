#!/usr/bin/env python3
"""Re-check the enrichment cost estimate against what prod actually booked (ENG-2987).

READ-ONLY. It only calls `aws logs describe-log-groups|filter-log-events` and `aws dynamodb scan|get-item`; it writes
nothing to AWS and prints aggregates only (a 6-character user id prefix, counts and dollars; never an email, a lead or a
field value). Test accounts (by email), platform admins (`isAdmin`) and any `--exclude-user-ids` are left out; real
customer accounts are kept whatever their email domain.

What it does: joins the enrichment runs found in the prod logs ("runEnrichment START" / "runEnrichment DONE") to the
usage ledger (AW-UsageRecords, features crm_enrichment and enrichment) per customer and day, then prints the booked
dollars per processed contact next to what the estimate formula quotes for leads that already have an email:

    quote per contact = fields * llmPerFieldPerLead + lookupPerLead + webSearchPerLead

where `fields` applies the customer quote's `effectiveFieldCount` formula (included fields plus their smart-field
dependencies, at least 1) to the list's SAVED enrichment config, or `referenceFieldCount` when there is none. The customer
quote counts the saved config merged with the list's current columns, so a column added to the list after the config was
saved counts there but not here (about 3% of the ratio per column).

The quote's Apollo email-search term is not part of that formula, so booked dollars here EXCLUDE `apollo:waterfall_email`
(the paid email search); that spend is shown in its own column.

The constants are read from backend/src/services/enrichmentCostEstimate.ts, so this check cannot drift from the code.
The ledger is per user and day, so a day that mixes an enrich run with a preview or another run is compared as a whole
(booked and contacts both include every run of that user-day). The prod log group keeps only 14 days: run this at least
every 14 days or the oldest runs are gone (the script warns when --since reaches past the retention).

It ends with a verdict: below --min-contacts or --min-customers it says INSUFFICIENT DATA and you must not retune.

Usage (needs read access to the prod CloudWatch log group and the AW-* DynamoDB tables):
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


def read_rate(name):
    """Read one numeric constant (a literal or simple arithmetic such as `(2.673 + 2.128) / 118`) from the source."""
    src = open(ESTIMATE_SRC, encoding="utf-8").read()
    m = re.search(r"^\s*%s:\s*([0-9.+\-*/() ]+?),\s*(?://.*)?$" % re.escape(name), src, re.M)
    if not m:
        sys.exit("cannot find %s in %s: did the estimate change shape? Update this script." % (name, ESTIMATE_SRC))
    val = _arith(m.group(1).strip(), name)
    if not (math.isfinite(val) and val > 0):
        sys.exit("%s must be a finite number above zero, got %r" % (name, val))
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
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError, RecursionError):
        sys.exit("unexpected expression for %s: %r" % (name, expr))


class Aws:
    def __init__(self, cli, region):
        self.base = shlex.split(cli) + ["--region", region]

    def __call__(self, *args):
        r = subprocess.run(self.base + list(args) + ["--output", "json"], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("aws %s failed: %s" % (" ".join(args[:2]), r.stderr.strip()[:400]))
        return json.loads(r.stdout) if r.stdout.strip() else {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    default_since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=14)).strftime("%Y-%m-%d")
    ap.add_argument("--since", default=default_since, help="first UTC day to include, YYYY-MM-DD (default: 14 days ago)")
    ap.add_argument("--exclude-emails", default="test@account.com",
                    help="comma-separated internal/test account emails to leave out (default: test@account.com)")
    ap.add_argument("--exclude-user-ids", default="", help="comma-separated user ids to leave out as well")
    ap.add_argument("--aws", default=os.environ.get("AWS_CLI", "aws"), help="aws command (default: $AWS_CLI or 'aws')")
    ap.add_argument("--region", default="us-west-2")
    ap.add_argument("--log-group", default=DEFAULT_LOG_GROUP)
    ap.add_argument("--min-contacts", type=int, default=100, help="below this many customer contacts: no retune (default 100)")
    ap.add_argument("--min-customers", type=int, default=3, help="below this many customers: no retune (default 3)")
    ap.add_argument("--tolerance", type=float, default=0.25, help="retune if booked/quote differs from 1 by more (default 0.25)")
    a = ap.parse_args()
    try:
        since_dt = dt.datetime.strptime(a.since, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        sys.exit("--since must be a real date, YYYY-MM-DD")

    llm_field = read_rate("llmPerFieldPerLead")
    lookup = read_rate("lookupPerLead")
    web = read_rate("webSearchPerLead")
    reference_fields = int(read_rate("referenceFieldCount"))
    aws = Aws(a.aws, a.region)

    excl = sorted({v for raw in a.exclude_emails.split(",") if raw.strip() for v in (raw.strip(), raw.strip().lower())})
    vals = {":e%d" % i: {"S": e} for i, e in enumerate(excl)}
    vals[":t"] = {"BOOL": True}
    cond = "isAdmin = :t" + (" OR email IN (%s)" % ", ".join(k for k in vals if k != ":t") if excl else "")
    d = aws("dynamodb", "scan", "--table-name", "AW-Users", "--projection-expression", "userId",
            "--filter-expression", cond, "--expression-attribute-values", json.dumps(vals))
    test_ids = {u["userId"]["S"] for u in d.get("Items", [])} | {x.strip() for x in a.exclude_user_ids.split(",") if x.strip()}

    start_ms = int(since_dt.timestamp() * 1000)
    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", a.log_group).get("logGroups", [])
    keep = next((g.get("retentionInDays") for g in groups if g.get("logGroupName") == a.log_group), None)
    if keep and since_dt < dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=keep):
        print("WARNING: the log group keeps only %d days, so runs before %s are already gone; the result below starts later than --since."
              % (keep, (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=keep)).strftime("%Y-%m-%d")))
    ev = lambda pat: aws("logs", "filter-log-events", "--log-group-name", a.log_group, "--start-time", str(start_ms),
                         "--filter-pattern", pat).get("events", [])
    starts = {}
    for x in ev('"runEnrichment START"'):
        m = re.search(r"listId=(\S+) userId=(\S+) mode=(\S+) runId=(\S+)", x["message"])
        if m:
            starts[m.group(4)] = (m.group(2), m.group(3), m.group(1))
    runs = []
    for x in ev('"runEnrichment DONE"'):
        m = re.search(r"runId=(\S+) processed=(\d+)", x["message"])
        if not m or m.group(1) not in starts:
            continue
        uid, mode, lid = starts[m.group(1)]
        day = dt.datetime.fromtimestamp(x["timestamp"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        runs.append(dict(uid=uid, day=day, mode=mode, p=int(m.group(2)), lid=lid))
    cust = [r for r in runs if r["uid"] not in test_ids]
    print("runs since %s: %d in the logs, %d from excluded test accounts, %d customer runs" % (a.since, len(runs), len(runs) - len(cust), len(cust)))

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

    print("\n%-13s %-14s %8s %6s %8s %7s %10s %12s  %s" % ("user/day", "modes", "contacts", "fields", "booked$*", "$/ctc*", "quote$/ctc", "booked/quote", "email-search $ (calls)"))
    tot_b = tot_q = tot_n = 0
    customers = set()
    for (uid, day), g in sorted(agg.items(), key=lambda kv: kv[0][1]):
        n = g["p"]
        if n == 0:
            continue
        L = led.get((uid, day), {})
        wf = L.get("apollo:waterfall_email", [0, 0])
        total = (sum(v[1] for v in L.values()) - wf[1]) / 1e6  # excludes the paid email search (own column)
        flds = g["fp"] / n  # weighted by contacts
        q = flds * llm_field + lookup + web
        print("%-13s %-14s %8d %6.1f %8.2f %7.3f %10.3f %12.2f  %.2f (%d)" % ("%s/%s" % (uid[:6], day[5:]), ",".join(g["modes"]), n, flds, total, total / n, q, total / n / q, wf[1] / 1e6, wf[0]))
        if g["modes"].get("enrich", 0) > 0:
            tot_b += total; tot_q += q * n; tot_n += n; customers.add(uid)

    print("\n* excluding the paid email search (apollo:waterfall_email), which is not part of the per-contact quote")
    print("\nVERDICT")
    if tot_n == 0:
        print("  No customer enrich-mode runs in the window: nothing to compare.")
        return
    if tot_b <= 0:
        print("  No booked cost found in the ledger for these runs (not written yet, or the wrong window): cannot compare.")
        return
    ratio = tot_b / tot_q
    print("  %d contacts from %d customers: booked $%.2f vs quote $%.2f (booked/quote = %.2f), email search excluded" % (tot_n, len(customers), tot_b, tot_q, ratio))
    if tot_n < a.min_contacts or len(customers) < a.min_customers:
        print("  INSUFFICIENT DATA (need >= %d contacts from >= %d customers): do NOT retune; run again later." % (a.min_contacts, a.min_customers))
    elif abs(ratio - 1) > a.tolerance:
        print("  DRIFT beyond +/-%d%%: retune ENRICHMENT_COST_RATES_USD in enrichmentCostEstimate.ts (see the runbook)." % round(a.tolerance * 100))
    else:
        print("  Within +/-%d%%: leave the constants alone." % round(a.tolerance * 100))


if __name__ == "__main__":
    main()
