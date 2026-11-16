#!/usr/bin/env python3
"""Re-check the enrichment cost estimate against what prod actually booked (ENG-2987).

READ-ONLY. It only calls `aws logs describe-log-groups|filter-log-events` and `aws dynamodb scan|get-item`; it writes
nothing to AWS and prints aggregates only (a 6-character user id prefix, counts and dollars; never an email, a lead or a
field value; AWS error text is reduced to its error code and operation because it can carry account names). The only guarantee that nothing can be written is the IAM role you run it with: use a read-only one. Left out
as non-customers (matched in Python, case-insensitively, so no email ever reaches a DynamoDB expression or the output): test
accounts (--exclude-emails), platform admins (`isAdmin`), every account whose email domain is, or is a subdomain of, one of
--exclude-domains (default agentweb.pro and argusoft.com) and any --exclude-user-ids. A look-alike such as
agentweb.pro.example.com stays in. Real customer accounts are kept whatever their email domain.

What it does: joins the enrichment runs found in the prod logs ("runEnrichment START" / "runEnrichment DONE") to the
usage ledger (AW-UsageRecords, features crm_enrichment and enrichment) per account and day, then prints the booked
dollars per processed contact next to what the estimate formula quotes for leads that already have an email:

    quote per contact = fields * llmPerFieldPerLead + lookupPerLead + webSearchPerLead

where `fields` applies the customer quote's `effectiveFieldCount` formula (included fields plus their smart-field
dependencies, at least 1) to the list's SAVED enrichment config, or `referenceFieldCount` when there is none. The customer
quote counts the saved config merged with the list's current columns, so a column added to the list after the config was
saved counts there but not here (about 3% of the ratio per column).

The per-contact quote has no term for the paid add-ons, so booked dollars here EXCLUDE them: the Apollo email search
(`apollo:waterfall_email`, booked as `apollo:full_enrichment` until the ENG-2720 change reached prod, last seen in the
ledger on 2026-11-03; the same $0.445 request) and Enigma
(`enigma:*`, which the customer quote adds separately for card-revenue fields). They are shown in their own columns.

Only the three rate constants (and referenceFieldCount) are read from backend/src/services/enrichmentCostEstimate.ts;
the formula above is duplicated here, so if `estimateEnrichmentCost` or `effectiveFieldCount` changes shape, update this
script. The ledger is per user and day, so a day that mixes an enrich run with a preview or another run is compared as a
whole (booked and contacts both include every run of that account-day). The prod log group keeps only 14 days: run this
at least every 14 days or the oldest runs are gone (the script warns when --since reaches into the lost part).

It ends with a verdict: below --min-contacts, or with fewer than --min-customers accounts that each supplied at least
--min-customer-contacts, or when one account supplies more than --max-account-share of the contacts, it says INSUFFICIENT
DATA and you must not retune (one list can be the very sample the constants were fitted to).

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
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")  # list, user and run ids copied from log text must look like this
MODES = ("enrich", "preview")
MAX_MARKER_OFFSET = 100  # real log lines carry the "[v3] runEnrichment" marker within the first ~60 characters
START_RE = re.compile(r"\[v3\] runEnrichment START listId=(\S+) userId=(\S+) mode=(\S+) runId=(\S+)")
DONE_RE = re.compile(r"\[v3\] runEnrichment DONE runId=(\S+) processed=([0-9]{1,9})(?!\S)")
EMAIL_SEARCH_MODELS = ("apollo:waterfall_email", "apollo:full_enrichment")  # same $0.445 request; the second is its older ledger name (last seen 2026-11-03)
ENIGMA_PREFIX = "enigma:"


def short(text, limit=60):
    """Keep error messages short: a hostile source line can be tens of kilobytes."""
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "... (%d characters)" % len(text)


def aws_error_summary(stderr):
    """AWS CLI error text can carry account names, ARNs or emails, so only the error code and the operation are shown."""
    m = re.search(r"An error occurred \(([A-Za-z0-9]{1,60})\) when calling the ([A-Za-z0-9]{1,60}) operation", stderr[:5000])
    if m:
        return "%s on %s" % (m.group(1), m.group(2))
    return "unrecognised error (its text is hidden because it can carry account names; run the same aws command by hand to read it)"


def plural(n, word):
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def read_rate(name):
    """Read one numeric constant (a literal or simple arithmetic such as `(2.673 + 2.128) / 118`) from the source."""
    where = os.path.relpath(ESTIMATE_SRC, REPO)
    with open(ESTIMATE_SRC, encoding="utf-8", errors="replace") as fh:
        src = fh.read(5_000_001)
    if len(src) > 5_000_000:
        sys.exit("%s is unexpectedly large" % where)
    pattern = re.compile(r"[ \t]*%s:[ \t]*([0-9.+\-*/() ]+?),[ \t]*(?://.*)?" % re.escape(name))
    m = None
    for line in src.splitlines():
        if len(line) <= 300:  # a constant line is short; skipping long lines keeps this linear on hostile input
            m = pattern.fullmatch(line)
            if m:
                break
    if not m:
        sys.exit("cannot find %s in %s: did the estimate change shape? Update this script." % (name, where))
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
        try:
            self.base = shlex.split(cli) + ["--region", region]
        except ValueError:
            sys.exit("--aws is not a valid command line (unbalanced quotes?)")
        if len(self.base) < 3:
            sys.exit("--aws must not be empty")

    def __call__(self, *args):
        label = " ".join(args[:2])
        try:
            r = subprocess.run(self.base + list(args) + ["--output", "json"], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL, timeout=1800)
        except FileNotFoundError:
            sys.exit("cannot run the --aws command (is the AWS CLI installed?)")
        except subprocess.TimeoutExpired:
            sys.exit("aws %s did not finish within 30 minutes (a credentials prompt, or a very wide --since)" % label)
        if r.returncode != 0:
            sys.exit("aws %s failed: %s" % (label, aws_error_summary(r.stderr)))
        return json.loads(r.stdout) if r.stdout.strip() else {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", required=True,
                    help="first UTC day to include, YYYY-MM-DD, zero-padded. Pick the day AFTER the last change to pricing or the "
                         "enrichment pipeline and keep it until the data is enough: runs from before a change give a false DRIFT")
    ap.add_argument("--exclude-emails", default="test@account.com",
                    help="comma-separated internal/test account emails to leave out, case-insensitive (default: the shared test account)")
    ap.add_argument("--exclude-domains", default="agentweb.pro,argusoft.com",
                    help="comma-separated email domains of internal staff; every account on them or on a subdomain is left out (default: agentweb.pro,argusoft.com)")
    ap.add_argument("--exclude-user-ids", default="", help="comma-separated user ids to leave out as well; a prefix of at least 6 characters (as printed in the table) is enough")
    ap.add_argument("--aws", default=os.environ.get("AWS_CLI", "aws"), help="aws command (default: $AWS_CLI or 'aws')")
    ap.add_argument("--region", default="us-west-2")
    ap.add_argument("--log-group", default=DEFAULT_LOG_GROUP)
    ap.add_argument("--min-contacts", type=int, default=100, help="below this many customer contacts: no retune (default 100)")
    ap.add_argument("--min-customers", type=int, default=3, help="below this many qualifying accounts: no retune (default 3)")
    ap.add_argument("--min-customer-contacts", type=int, default=10,
                    help="an account counts toward --min-customers only with at least this many contacts (default 10)")
    ap.add_argument("--max-account-share", type=float, default=0.5,
                    help="INSUFFICIENT DATA when one account supplies more than this share of the contacts (default 0.5)")
    ap.add_argument("--tolerance", type=float, default=0.25, help="retune if booked/quote differs from 1 by more (default 0.25)")
    a = ap.parse_args()
    if not (math.isfinite(a.tolerance) and a.tolerance > 0):
        ap.error("--tolerance must be a finite number above zero")
    if not (math.isfinite(a.max_account_share) and 0 < a.max_account_share <= 1):
        ap.error("--max-account-share must be above 0 and at most 1")
    for flag in ("min_contacts", "min_customers", "min_customer_contacts"):
        if getattr(a, flag) < 1:
            ap.error("--%s must be at least 1" % flag.replace("_", "-"))
    now = dt.datetime.now(dt.timezone.utc)
    if not re.fullmatch(r"[A-Za-z0-9/][A-Za-z0-9_./#-]*", a.log_group):  # the AWS CLI reads a file for values like file:///path and takes a leading dash as a flag
        sys.exit("--log-group must start with a letter, digit or / and contain only letters, digits and _ . / # -")
    if not re.fullmatch(r"[a-z][a-z0-9-]*", a.region):
        sys.exit("--region must look like us-west-2")
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

    # Accounts to leave out. The user table is read whole and matched here, so emails (kept in memory only, never printed) are
    # never put into a DynamoDB expression and the match is case-insensitive.
    excl_emails = {raw.strip().lower() for raw in a.exclude_emails.split(",") if raw.strip()}
    domains = sorted({x.strip().lower().lstrip("@.") for x in a.exclude_domains.split(",") if x.strip().lstrip("@.")})
    id_entries = [x.strip() for x in a.exclude_user_ids.split(",") if x.strip()]
    for entry in id_entries:
        if len(entry) < 6:
            sys.exit("--exclude-user-ids entries must be at least 6 characters (the prefix printed in the table)")
    d = aws("dynamodb", "scan", "--table-name", "AW-Users", "--projection-expression", "userId, email, isAdmin")
    users = [u for u in d.get("Items", []) if u.get("userId", {}).get("S")]
    if not users:
        sys.exit("the user table scan returned no accounts, so staff cannot be told from customers: refusing to continue")
    why = {"platform admins": set(), "test emails": set(), "internal domains": set(), "--exclude-user-ids": set()}
    matched_entries = set()
    for u in users:
        uid = u["userId"]["S"]
        em = (u.get("email", {}).get("S") or "").strip().lower()
        if u.get("isAdmin", {}).get("BOOL"):
            why["platform admins"].add(uid)
        if em in excl_emails:
            why["test emails"].add(uid)
        if any(em.endswith("@" + dom) or em.endswith("." + dom) for dom in domains):
            why["internal domains"].add(uid)
        for entry in id_entries:
            if uid.startswith(entry):
                why["--exclude-user-ids"].add(uid); matched_entries.add(entry)
    test_ids = set().union(*why.values())
    for i, entry in enumerate(id_entries, 1):
        if entry not in matched_entries:
            print("WARNING: no account matches --exclude-user-ids entry number %d (%d characters)" % (i, len(entry)))
    print("excluded accounts: %d of %d (%s; one account can match several rules)"
          % (len(test_ids), len(users), ", ".join("%s %d" % (k, len(v)) for k, v in why.items())))

    start_ms = int(since_dt.timestamp() * 1000)
    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", a.log_group).get("logGroups", [])
    keep = next((g.get("retentionInDays") for g in groups if g.get("logGroupName") == a.log_group), None)
    oldest_day = (now - dt.timedelta(days=keep)).date() if keep else None
    if oldest_day and since_dt.date() <= oldest_day:
        print("WARNING: the log group keeps only %d days: runs before %s are already gone and %s itself is only partly covered, while the "
              "ledger counts whole days (that inflates the ratio). Start --since at %s for a clean result."
              % (keep, oldest_day.strftime("%Y-%m-%d"), oldest_day.strftime("%Y-%m-%d"), (oldest_day + dt.timedelta(days=1)).strftime("%Y-%m-%d")))
    events = aws("logs", "filter-log-events", "--log-group-name", a.log_group, "--start-time", str(start_ms),
                 "--filter-pattern", '?"runEnrichment START" ?"runEnrichment DONE"').get("events", [])
    starts, finished, ignored_ids = {}, {}, set()
    odd_lines = 0
    for x in events:
        msg = x.get("message") or ""
        ts = x.get("timestamp")
        m = START_RE.search(msg)
        if m:
            lid, uid, mode, rid = m.groups()
            if m.start() > MAX_MARKER_OFFSET or mode not in MODES or not all(ID_RE.fullmatch(v) for v in (lid, uid, rid)):
                odd_lines += 1  # only the fixed mode names and plain ids are ever copied into the table
                if ID_RE.fullmatch(rid):
                    ignored_ids.add(rid)
                continue
            starts[rid] = (uid, mode, lid)
            continue
        m = DONE_RE.search(msg)
        if m:
            rid = m.group(1)
            if m.start() > MAX_MARKER_OFFSET or not ID_RE.fullmatch(rid) or not isinstance(ts, int):
                odd_lines += 1
                continue
            if rid not in finished:  # a repeated DONE line must not count a run twice
                finished[rid] = (int(m.group(2)), ts)
    runs = []
    for rid, (processed, ts) in finished.items():
        if rid not in starts:
            continue
        uid, mode, lid = starts[rid]
        day = dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
        runs.append(dict(uid=uid, day=day, mode=mode, p=processed, lid=lid))
    cust = [r for r in runs if r["uid"] not in test_ids]
    print("runs since %s: %d in the logs, %d from excluded accounts, %d customer runs" % (a.since, len(runs), len(runs) - len(cust), len(cust)))
    if odd_lines:
        print("ignored %s with an unexpected mode or user id" % plural(odd_lines, "log line"))
    unfinished = sum(1 for rid, st in starts.items() if rid not in finished and st[0] not in test_ids)
    orphans = sum(1 for rid in finished if rid not in starts and rid not in ignored_ids)
    print("not counted: %s of customer accounts started but not finished (still running or crashed; their cost sits in the booked dollars "
          "with no contacts), %s finished whose start is before --since (account unknown)" % (plural(unfinished, "run"), plural(orphans, "run")))

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
    skipped_rows = 0
    for r in d.get("Items", []):
        try:
            k = (r["userId"]["S"], r["date"]["S"])
            calls, micro = int(r["callCount"]["N"]), int(r["costMicroUsd"]["N"])
            model = r["model"]["S"]
        except (KeyError, ValueError, TypeError):
            skipped_rows += 1
            continue
        led[k][model][0] += calls
        led[k][model][1] += micro
    if skipped_rows:
        print("skipped %s that did not have the expected fields" % plural(skipped_rows, "ledger row"))

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
        wf = [sum(L.get(m, [0, 0])[0] for m in EMAIL_SEARCH_MODELS), sum(L.get(m, [0, 0])[1] for m in EMAIL_SEARCH_MODELS)]
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
    share = max(by_account.values()) / tot_n
    print("  %d contacts from %s: booked $%.2f vs quote $%.2f (booked/quote = %.2f), paid add-ons excluded"
          % (tot_n, plural(len(by_account), "account"), tot_b, tot_q, ratio))
    print("  the largest account supplies %.1f%% of the contacts; %d of them supplied at least %d contacts each"
          % (100 * share, len(qualifying), a.min_customer_contacts))
    short_of = []
    if tot_n < a.min_contacts:
        short_of.append("only %d contacts (need %d)" % (tot_n, a.min_contacts))
    if len(qualifying) < a.min_customers:
        short_of.append("only %s with at least %d contacts each (need %d)" % (plural(len(qualifying), "account"), a.min_customer_contacts, a.min_customers))
    if share > a.max_account_share:
        short_of.append("one account supplies %.1f%% of the contacts (at most %g%% allowed)" % (100 * share, 100 * a.max_account_share))
    if short_of:
        print("  INSUFFICIENT DATA (%s): do NOT retune; run again later with the same --since." % "; ".join(short_of))
    elif abs(ratio - 1) > a.tolerance:
        print("  DRIFT beyond +/-%g%%: retune ENRICHMENT_COST_RATES_USD in enrichmentCostEstimate.ts (see the runbook)." % (100 * a.tolerance))
    else:
        print("  Within +/-%g%%: leave the constants alone." % (100 * a.tolerance))


if __name__ == "__main__":
    main()
